import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../lib/env.js';

export interface AuthStackProps extends StackProps {
  readonly config: EnvConfig;
  /**
   * Post-confirmation triggers, built in the worker stack because they reach the database
   * and therefore need the VPC and the proxy that stack already wires.
   */
  readonly merchantPostConfirmation?: lambda.IFunction;
  readonly buyerPostConfirmation?: lambda.IFunction;
  readonly vpc?: ec2.IVpc;
  /** Used for the OAuth callback and logout URLs. */
  readonly buyerAppUrl?: string;
}

/**
 * DC1 — Cognito is the identity layer, Razorpay is a payment connection.
 *
 * Originally a merchant signed in *with* Razorpay OAuth, which conflated two unrelated
 * questions: who is this person, and which payment account have they connected. Separating
 * them means a merchant can sign up and build a catalogue before their Razorpay account is
 * ready, and losing a payment connection no longer locks them out of the dashboard.
 *
 * **Two pools, not one pool with groups.** A single pool would put buyers and merchants in
 * the same token issuer, so every merchant route would have to check a group claim to stay
 * safe and one missing check would expose the merchant surface to any buyer. Separate
 * pools make that failure impossible rather than merely unlikely: a buyer's token is signed
 * by an issuer the merchant authorizer does not accept, so it is rejected before any
 * handler runs.
 */
export class AuthStack extends Stack {
  readonly merchantPool: cognito.UserPool;
  readonly buyerPool: cognito.UserPool;
  readonly merchantClient: cognito.UserPoolClient;
  readonly buyerClient: cognito.UserPoolClient;
  /** The client Claude and ChatGPT use, via OAuth 2.1 + PKCE (T2.7). */
  readonly mcpClient: cognito.UserPoolClient;
  readonly buyerDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { config } = props;
    const isProd = config.name === 'prod';

    /**
     * Ten characters with three classes, not the eight Cognito defaults to.
     *
     * A merchant dashboard password protects a live catalogue and, after Block C, the
     * ability to change where money is collected. Requiring symbols on top of this trades
     * real usability for very little entropy, so it is deliberately not required.
     */
    const passwordPolicy: cognito.PasswordPolicy = {
      minLength: 10,
      requireLowercase: true,
      requireUppercase: true,
      requireDigits: true,
      requireSymbols: false,
      tempPasswordValidity: Duration.days(7),
    };

    // ── Merchant pool ──────────────────────────────────────────────────────────

    this.merchantPool = new cognito.UserPool(this, 'MerchantPool', {
      userPoolName: `${config.resourcePrefix}-${config.name}-merchants`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: true, mutable: true },
        phoneNumber: { required: false, mutable: true },
      },
      customAttributes: {
        /**
         * Mutable, because the post-confirmation trigger writes it *after* the user is
         * created — an immutable attribute could never be set by the trigger at all.
         */
        merchant_id: new cognito.StringAttribute({ mutable: true, maxLen: 64 }),
      },
      passwordPolicy,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      ...(props.merchantPostConfirmation
        ? { lambdaTriggers: { postConfirmation: props.merchantPostConfirmation } }
        : {}),
      /**
       * Retained outside dev. Destroying a user pool deletes every account in it, and
       * there is no export that brings passwords back — a stack rename in staging would
       * silently sign every merchant out forever.
       */
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.merchantClient = this.merchantPool.addClient('MerchantWebClient', {
      userPoolClientName: `${config.resourcePrefix}-${config.name}-merchant-web`,
      /**
       * No client secret. This is a browser SPA: a secret shipped in a bundle is not a
       * secret, and Cognito's SRP flow is designed for exactly this case.
       */
      generateSecret: false,
      authFlows: { userSrp: true, custom: false, userPassword: false, adminUserPassword: false },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      /**
       * Rotates the refresh token on every use, so a stolen one is usable only until the
       * legitimate client refreshes next — and the resulting reuse is detectable.
       */
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    // ── Buyer pool ─────────────────────────────────────────────────────────────

    this.buyerPool = new cognito.UserPool(this, 'BuyerPool', {
      userPoolName: `${config.resourcePrefix}-${config.name}-buyers`,
      selfSignUpEnabled: true,
      /**
       * Email *and* phone, because an Indian buyer is far more likely to have a phone
       * number they use everywhere than an email address they check.
       */
      signInAliases: { email: true, phone: true },
      autoVerify: { email: true, phone: true },
      standardAttributes: {
        email: { required: false, mutable: true },
        phoneNumber: { required: false, mutable: true },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        buyer_id: new cognito.StringAttribute({ mutable: true, maxLen: 64 }),
      },
      passwordPolicy,
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.EMAIL_AND_PHONE_WITHOUT_MFA,
      ...(props.buyerPostConfirmation
        ? { lambdaTriggers: { postConfirmation: props.buyerPostConfirmation } }
        : {}),
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.buyerClient = this.buyerPool.addClient('BuyerWebClient', {
      userPoolClientName: `${config.resourcePrefix}-${config.name}-buyer-web`,
      generateSecret: false,
      authFlows: { userSrp: true, custom: false, userPassword: false, adminUserPassword: false },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    /**
     * T2.7 — letting an assistant act for a buyer, through Cognito rather than around it.
     *
     * Cognito is already an OAuth 2.1 authorization server with PKCE, a hosted login page
     * and a discovery document. Writing our own would mean owning token issuance, refresh,
     * revocation and consent for a flow whose entire security rests on getting those right —
     * so the MCP server delegates, and only ever validates.
     *
     * The scopes are deliberately narrow and separately grantable. A buyer connecting their
     * assistant is agreeing to let it spend their money, and "read your addresses" and
     * "place orders as you" should not be one undifferentiated yes.
     */
    const resourceServer = this.buyerPool.addResourceServer('McpResourceServer', {
      identifier: 'catalograil',
      userPoolResourceServerName: 'Conciergent MCP',
      scopes: [
        new cognito.ResourceServerScope({
          scopeName: 'addresses.read',
          scopeDescription: 'See your saved delivery addresses',
        }),
        new cognito.ResourceServerScope({
          scopeName: 'orders.read',
          scopeDescription: 'See your orders and their status',
        }),
        new cognito.ResourceServerScope({
          scopeName: 'orders.write',
          scopeDescription: 'Place orders on your behalf',
        }),
      ],
    });

    /**
     * The hosted login page an assistant redirects a buyer to.
     *
     * A Cognito-prefixed domain rather than a custom one: a custom domain needs an ACM
     * certificate in us-east-1 and a DNS record, and neither adds security here — what the
     * buyer needs to recognise is the Conciergent branding on the page, which the hosted UI
     * carries either way.
     */
    this.buyerDomain = this.buyerPool.addDomain('BuyerDomain', {
      cognitoDomain: { domainPrefix: `${config.resourcePrefix}-${config.name}-buyers` },
    });

    this.mcpClient = this.buyerPool.addClient('McpClient', {
      userPoolClientName: `${config.resourcePrefix}-${config.name}-mcp`,
      /**
       * No secret. Claude and ChatGPT are public clients — they run on someone else's
       * machine and cannot keep one — which is exactly the case PKCE exists for.
       */
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.resourceServer(resourceServer, new cognito.ResourceServerScope({
            scopeName: 'addresses.read',
            scopeDescription: 'See your saved delivery addresses',
          })),
          cognito.OAuthScope.resourceServer(resourceServer, new cognito.ResourceServerScope({
            scopeName: 'orders.read',
            scopeDescription: 'See your orders and their status',
          })),
          cognito.OAuthScope.resourceServer(resourceServer, new cognito.ResourceServerScope({
            scopeName: 'orders.write',
            scopeDescription: 'Place orders on your behalf',
          })),
        ],
        /**
         * Both assistants' callback URLs.
         *
         * Registered explicitly rather than by wildcard: a redirect URI is the one place an
         * authorization code can be sent, and a loose entry here is how a code ends up
         * somewhere it should not.
         */
        callbackUrls: [
          'https://claude.ai/api/mcp/auth_callback',
          'https://claude.com/api/mcp/auth_callback',
          'https://chatgpt.com/connector_platform_oauth_redirect',
          'https://chat.openai.com/aip/oauth/callback',
          ...(props.buyerAppUrl ? [`${props.buyerAppUrl.replace(/\/$/, '')}/connected`] : []),
        ],
        logoutUrls: props.buyerAppUrl ? [props.buyerAppUrl] : [],
      },
      authFlows: { userSrp: true },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      // Thirty days, so a buyer does not have to reconnect their assistant every week —
      // and revocable, so disconnecting actually disconnects.
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    new CfnOutput(this, 'BuyerHostedUiDomain', {
      value: this.buyerDomain.baseUrl(),
      description: 'Where buyers sign in when connecting an assistant',
    });
    new CfnOutput(this, 'McpClientId', { value: this.mcpClient.userPoolClientId });

    // ── Outputs the dashboards need at build time ──────────────────────────────

    new CfnOutput(this, 'MerchantUserPoolId', { value: this.merchantPool.userPoolId });
    new CfnOutput(this, 'MerchantUserPoolClientId', {
      value: this.merchantClient.userPoolClientId,
    });
    new CfnOutput(this, 'BuyerUserPoolId', { value: this.buyerPool.userPoolId });
    new CfnOutput(this, 'BuyerUserPoolClientId', { value: this.buyerClient.userPoolClientId });
  }
}
