import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpIamAuthorizer,
  HttpJwtAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../lib/env.js';
import { createFunction, databaseEnvironment } from '../lib/lambda.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

export interface ApiStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly vpc: ec2.IVpc;
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  readonly proxy: rds.DatabaseProxy;
  readonly uploadsBucket: s3.IBucket;
  /** DynamoDB tables the search path uses (T1.19, T1.20). */
  readonly queryCacheTable: dynamodb.ITable;
  readonly searchLogsTable: dynamodb.ITable;
  /** Product writes enqueue enrichment; `/health/deep` also probes it. */
  readonly enrichmentQueue: sqs.IQueue;
  /** Envelope-encrypts merchant Razorpay credentials (rule 3, S3.1). */
  readonly tokenKey: kms.IKey;
  /** Conditional writes that make webhook delivery idempotent (rule 2, T2.16). */
  readonly idempotencyTable: dynamodb.ITable;
  /** Checkout sessions and spent handoff tokens (T2.13, T2.14). */
  readonly sessionsTable: dynamodb.ITable;
  /**
   * Signs handoff tokens.
   *
   * Passed in rather than generated here so it survives a stack replacement — regenerating
   * it would invalidate every checkout link in flight, which for a buyer mid-purchase is
   * indistinguishable from the product being broken.
   */
  readonly handoffSecret: string;
  readonly buyerAppUrl: string;
  /**
   * Cognito pools (DC1). Optional so the API can still be synthesised and deployed before
   * the auth stack exists — without them the routes keep the IAM gate rather than becoming
   * unauthenticated, which is the safe direction to fail.
   */
  readonly merchantPool?: cognito.IUserPool;
  readonly merchantPoolClient?: cognito.IUserPoolClient;
  readonly buyerPool?: cognito.IUserPool;
  readonly buyerPoolClient?: cognito.IUserPoolClient;
}

/**
 * The merchant HTTP API.
 *
 * Every route is behind IAM authorization, and that is not a placeholder to tidy up later —
 * it is what makes the stack safe to deploy before T1.6 exists. `POST /merchant/uploads`
 * hands back a presigned URL scoped to a merchant's own S3 prefix, so an unauthenticated
 * version of it would let anyone write into anyone's catalogue. IAM auth means only a
 * SigV4-signed request from a principal in this account gets through, which is the right
 * gate for a development deployment and is replaced, not merely relaxed, when the Razorpay
 * OAuth session lands.
 */
export class ApiStack extends Stack {
  readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { config, vpc, lambdaSecurityGroup, proxy } = props;

    const merchantApi = createFunction(this, 'MerchantApi', {
      config,
      entry: path.join(REPO_ROOT, 'services/api-merchant/src/handler.ts'),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.seconds(29), // API Gateway gives up at 30.
      environment: {
        ...databaseEnvironment(proxy.endpoint),
        S3_BUCKET_UPLOADS: props.uploadsBucket.bucketName,
        // Product create and update enqueue enrichment (T1.12).
        SQS_QUEUE_ENRICHMENT: props.enrichmentQueue.queueUrl,
        // Read only by `/health/deep`, which probes each dependency by name.
        DDB_TABLE_QUERY_CACHE: props.queryCacheTable.tableName,
        BEDROCK_REGION: this.region,
        BEDROCK_TEXT_EMBED_MODEL_ID: 'global.cohere.embed-v4:0',
        // T1.9 reads and summarises a merchant's policy pages through Bedrock.
        ANTHROPIC_POLICY_MODEL: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        KMS_TOKEN_KEY_ID: props.tokenKey.keyId,
      },
    });

    proxy.grantConnect(merchantApi, 'catalograil');
    /**
     * Encrypt and decrypt, not manage. The API mints and reads credential ciphertexts and
     * has no business rotating or deleting the key that protects every merchant's.
     */
    props.tokenKey.grantEncryptDecrypt(merchantApi);
    // Presigning a PUT requires the permission the URL will carry.
    props.uploadsBucket.grantPut(merchantApi);
    props.enrichmentQueue.grantSendMessages(merchantApi);

    /**
     * Permissions `/health/deep` needs to probe each dependency.
     *
     * Read-only and metadata-only by design: the health check reports reachability, so it
     * must not be able to change anything it touches. `HeadBucket` and `DescribeTable` are
     * the cheapest calls that still prove the network path and the IAM grant together.
     */
    props.queryCacheTable.grant(merchantApi, 'dynamodb:DescribeTable');
    merchantApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [props.uploadsBucket.bucketArn],
      }),
    );
    merchantApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          'arn:aws:bedrock:*:*:inference-profile/*',
        ],
      }),
    );

    this.api = new apigw.HttpApi(this, 'MerchantHttpApi', {
      apiName: `${config.resourcePrefix}-${config.name}-merchant`,
      description: 'Merchant-facing API',
      /**
       * S1.4. Explicit origins, never `*`.
       *
       * The wildcard that was here is rejected by every browser on a credentialed request,
       * so it failed exactly the calls the dashboards make. Origins now come from config
       * per environment (`-c appOrigins=...`), and `resolveEnv` refuses a `*`.
       */
      corsPreflight: {
        allowOrigins: [...config.appOrigins],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['content-type', 'authorization', 'x-correlation-id', 'x-merchant-id'],
        maxAge: Duration.days(1),
      },
    });

    /**
     * The internal search API (T1.19).
     *
     * A separate function from the merchant API, not because the code demands it but
     * because their shapes differ: search is latency-critical with a 200ms budget and
     * needs Bedrock, while the merchant API is a CRUD surface. Sharing one function would
     * mean the merchant API's cold starts and memory footprint set search's floor.
     */
    const internalApi = createFunction(this, 'InternalApi', {
      config,
      entry: path.join(REPO_ROOT, 'services/api-internal/src/handler.ts'),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.seconds(29),
      // Larger than the merchant API: a search holds a 1024-float query vector and hydrates
      // a page of results, and CPU scales with memory on Lambda.
      memorySize: 2048,
      environment: {
        ...databaseEnvironment(proxy.endpoint),
        DDB_TABLE_QUERY_CACHE: props.queryCacheTable.tableName,
        DDB_TABLE_SEARCH_LOGS: props.searchLogsTable.tableName,
        BEDROCK_REGION: this.region,
        BEDROCK_TEXT_EMBED_MODEL_ID: 'global.cohere.embed-v4:0',
        BEDROCK_IMAGE_EMBED_MODEL_ID: 'global.cohere.embed-v4:0',
      },
    });

    proxy.grantConnect(internalApi, 'catalograil');
    props.queryCacheTable.grantReadWriteData(internalApi);
    props.searchLogsTable.grantWriteData(internalApi);
    internalApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        // Embed v4 is reached through a global inference profile, which may route to any
        // region, so the resource cannot be pinned to this one.
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          'arn:aws:bedrock:*:*:inference-profile/*',
        ],
      }),
    );

    /**
     * Added after the API exists rather than in the environment above, because the Lambda
     * is constructed first and its own endpoint is not knowable until then. The merchant
     * needs this to register their webhook with Razorpay (S3.3).
     */
    merchantApi.addEnvironment('API_BASE_URL', this.api.apiEndpoint);

    const integration = new HttpLambdaIntegration('MerchantIntegration', merchantApi);

    /**
     * S2.3 — a JWT authorizer per pool, routed by path prefix.
     *
     * Separate authorizers rather than one with two issuers: a buyer's token is signed by
     * an issuer the merchant authorizer does not accept, so it is rejected at the gateway
     * before any handler runs. Cross-pool rejection is therefore a property of the
     * deployment rather than a check someone has to remember to write.
     *
     * `identitySource` is the standard bearer header. Falling back to the IAM authorizer
     * when a pool is absent keeps the routes closed rather than open — the failure mode of
     * a partial deploy should be "nobody can call this", not "anybody can".
     */
    const merchantAuthorizer =
      props.merchantPool && props.merchantPoolClient
        ? new HttpJwtAuthorizer(
            'MerchantJwtAuthorizer',
            `https://cognito-idp.${this.region}.amazonaws.com/${props.merchantPool.userPoolId}`,
            {
              jwtAudience: [props.merchantPoolClient.userPoolClientId],
              identitySource: ['$request.header.Authorization'],
            },
          )
        : new HttpIamAuthorizer();

    const buyerAuthorizer =
      props.buyerPool && props.buyerPoolClient
        ? new HttpJwtAuthorizer(
            'BuyerJwtAuthorizer',
            `https://cognito-idp.${this.region}.amazonaws.com/${props.buyerPool.userPoolId}`,
            {
              jwtAudience: [props.buyerPoolClient.userPoolClientId],
              identitySource: ['$request.header.Authorization'],
            },
          )
        : new HttpIamAuthorizer();

    /**
     * Explicit methods, deliberately **not** `ANY` (S1.1, diagnosis cause 1).
     *
     * `ANY` matches `OPTIONS` too, so the IAM authorizer ran on the CORS preflight and
     * answered 403. A browser treats any non-2xx preflight as a CORS failure and never
     * sends the real request — which is why every dashboard call failed with nothing
     * useful in the Network tab. Listing the methods leaves `OPTIONS` unrouted, so the
     * API's own `corsPreflight` handles it unauthenticated, which is what it is for.
     */
    this.api.addRoutes({
      path: '/merchant/{proxy+}',
      methods: [
        apigw.HttpMethod.GET,
        apigw.HttpMethod.POST,
        apigw.HttpMethod.PUT,
        apigw.HttpMethod.PATCH,
        apigw.HttpMethod.DELETE,
      ],
      integration,
      authorizer: merchantAuthorizer,
    });

    /**
     * S1.5 — health, unauthenticated on purpose.
     *
     * It reports whether the API and its dependencies are reachable, which is exactly the
     * question you need answered when auth is the thing that is broken. It returns no
     * catalogue data, no merchant data and no identifiers, so there is nothing here worth
     * gating; putting it behind the gate would make it useless for the failure it exists
     * to diagnose.
     */
    this.api.addRoutes({
      path: '/health',
      methods: [apigw.HttpMethod.GET],
      integration,
    });

    this.api.addRoutes({
      path: '/health/{proxy+}',
      methods: [apigw.HttpMethod.GET],
      integration,
    });

    this.api.addRoutes({
      path: '/internal/{proxy+}',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('InternalIntegration', internalApi),
      /**
       * Stays on IAM.
       *
       * `/internal/*` is machine-to-machine — the MCP server and the merchant dashboard's
       * "preview in AI" both call it — and SigV4 is the right gate for a caller that is a
       * service rather than a person. The buyer-facing search route that a browser calls
       * is `/buyer/search` below, which takes the buyer JWT.
       */
      authorizer: new HttpIamAuthorizer(),
    });

    /**
     * The merchant dashboard's "Preview in AI" (T1.25), behind the merchant pool.
     *
     * It runs the same search a buyer gets, so it must not be a different implementation —
     * a preview that ranks differently from the real thing is worse than no preview. It
     * needs its own route because `/internal/*` is SigV4-only and a browser cannot sign,
     * which is why the preview page could not work at all.
     */
    this.api.addRoutes({
      path: '/merchant/search-preview',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('PreviewIntegration', internalApi),
      authorizer: merchantAuthorizer,
    });

    /**
     * Public search.
     *
     * Browsing needs no account, deliberately (S2.6): a buyer who must sign up before they
     * can look at anything will not sign up. It is also consistent with what this product
     * is — the same catalogue is answered into Claude and ChatGPT, where there is no login
     * at all, so treating the dashboard as more private than the MCP surface would be
     * pretending.
     *
     * Personal things — a profile, an address, an order history — are behind the pool below.
     */
    this.api.addRoutes({
      path: '/search',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('PublicSearchIntegration', internalApi),
    });

    // Opening a product needs no account either: the listing already carries the price, the
    // merchant and the delivery estimate, so gating the detail would be a half-measure.
    this.api.addRoutes({
      path: '/product',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('PublicProductIntegration', internalApi),
    });

    /**
     * The buyer's own account, behind the buyer pool.
     *
     * A separate Lambda from search: search is latency-critical with a 200ms budget and
     * needs Bedrock, while this is a small CRUD surface. Sharing one function would make
     * search carry this one's cold starts.
     */
    const buyerApi = createFunction(this, 'BuyerApi', {
      config,
      entry: path.join(REPO_ROOT, 'services/api-buyer/src/handler.ts'),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.seconds(29),
      memorySize: 1024,
      environment: {
        ...databaseEnvironment(proxy.endpoint),
        KMS_TOKEN_KEY_ID: props.tokenKey.keyId,
        DDB_TABLE_IDEMPOTENCY: props.idempotencyTable.tableName,
        DDB_TABLE_SESSIONS: props.sessionsTable.tableName,
        HANDOFF_TOKEN_SECRET: props.handoffSecret,
        BUYER_APP_URL: props.buyerAppUrl,
      },
    });

    proxy.grantConnect(buyerApi, 'catalograil');
    props.tokenKey.grantEncryptDecrypt(buyerApi);
    props.idempotencyTable.grantReadWriteData(buyerApi);
    props.sessionsTable.grantReadWriteData(buyerApi);

    /**
     * The Razorpay webhook, unauthenticated at the gateway and authenticated by HMAC.
     *
     * Razorpay has no JWT of ours and never will. Its signature — verified against the
     * merchant's own secret — proves both who sent it and that the body is unaltered, which
     * a bearer token would not.
     */
    /**
     * Checkout, unauthenticated at the gateway.
     *
     * A guest buys without an account (T2.21), and requiring one here is the clearest way
     * to lose a buyer who has already decided. What authorises these is the single-use
     * handoff token, checked inside the handler.
     */
    this.api.addRoutes({
      path: '/checkout/{proxy+}',
      methods: [apigw.HttpMethod.POST, apigw.HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('CheckoutIntegration', buyerApi),
    });

    this.api.addRoutes({
      path: '/webhooks/razorpay/{merchantId}',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', buyerApi),
    });

    this.api.addRoutes({
      path: '/buyer/{proxy+}',
      methods: [
        apigw.HttpMethod.GET,
        apigw.HttpMethod.POST,
        apigw.HttpMethod.PATCH,
        apigw.HttpMethod.DELETE,
      ],
      integration: new HttpLambdaIntegration('BuyerIntegration', buyerApi),
      authorizer: buyerAuthorizer,
    });

    new CfnOutput(this, 'MerchantApiUrl', {
      value: this.api.apiEndpoint,
      description: 'Merchant API base URL (requests must be SigV4 signed)',
    });
  }
}
