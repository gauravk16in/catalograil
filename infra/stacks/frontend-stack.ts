import { CfnOutput, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../lib/env.js';

export interface FrontendStackProps extends StackProps {
  readonly config: EnvConfig;
  /** Base URL of the merchant HTTP API, injected at build time. */
  readonly apiBaseUrl: string;
  /** `owner/repo` on GitHub. */
  readonly repository: string;
  /**
   * Secrets Manager secret holding a GitHub personal access token with `repo` scope.
   *
   * Referenced by name rather than value so the token never enters a CloudFormation
   * template, a CDK context file, or this repository — Amplify resolves it at deploy time.
   */
  readonly githubTokenSecretName: string;
  /** Branch Amplify builds from. */
  readonly branch?: string;
}

/**
 * Amplify Hosting for the two dashboards.
 *
 * Both are Next.js apps in a pnpm monorepo, which is the whole difficulty: Amplify's
 * default build assumes a single app at the repository root. The build specs below install
 * once from the root — pnpm workspaces cannot install a single package in isolation — and
 * then build only the app in question.
 *
 * Amplify is Git-connected rather than manually deployed. A manual deploy would work today
 * and then require someone to remember it forever; a connected branch means the dashboards
 * follow the same review-and-merge path as everything else in the repository.
 */
export class FrontendStack extends Stack {
  readonly merchantApp: amplify.CfnApp;
  readonly buyerApp: amplify.CfnApp;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { config } = props;
    const branch = props.branch ?? 'main';

    /**
     * Amplify needs a role to write its own build logs and read the source. Scoped to the
     * managed Amplify policy rather than hand-rolled, because the permissions Amplify's
     * build container needs are its own business and change with the service.
     */
    const role = new iam.Role(this, 'AmplifyRole', {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess-Amplify')],
    });

    const githubToken = SecretValue.secretsManager(props.githubTokenSecretName);

    this.merchantApp = this.createApp({
      id: 'MerchantApp',
      name: `${config.resourcePrefix}-${config.name}-merchant`,
      description: 'Merchant dashboard',
      appDirectory: 'apps/merchant',
      repository: props.repository,
      githubToken,
      roleArn: role.roleArn,
      environment: {
        NEXT_PUBLIC_API_BASE_URL: props.apiBaseUrl,
        NEXT_PUBLIC_STAGE: config.name,
      },
    });

    this.buyerApp = this.createApp({
      id: 'BuyerApp',
      name: `${config.resourcePrefix}-${config.name}-buyer`,
      description: 'Buyer search and orders',
      appDirectory: 'apps/buyer',
      repository: props.repository,
      githubToken,
      roleArn: role.roleArn,
      environment: {
        NEXT_PUBLIC_API_BASE_URL: props.apiBaseUrl,
        NEXT_PUBLIC_STAGE: config.name,
      },
    });

    for (const [appId, app] of [
      ['Merchant', this.merchantApp],
      ['Buyer', this.buyerApp],
    ] as const) {
      new amplify.CfnBranch(this, `${appId}Branch`, {
        appId: app.attrAppId,
        branchName: branch,
        stage: config.name === 'prod' ? 'PRODUCTION' : 'DEVELOPMENT',
        enableAutoBuild: true,
        // A pull request preview per branch is genuinely useful for a dashboard, and cheap:
        // Amplify only builds them when a PR is open.
        enablePullRequestPreview: config.name !== 'prod',
      });

      new CfnOutput(this, `${appId}AppUrl`, {
        value: `https://${branch}.${app.attrDefaultDomain}`,
        description: `${appId} dashboard URL`,
      });
    }
  }

  private createApp(options: {
    id: string;
    name: string;
    description: string;
    appDirectory: string;
    repository: string;
    githubToken: SecretValue;
    roleArn: string;
    environment: Record<string, string>;
  }): amplify.CfnApp {
    const app = new amplify.CfnApp(this, options.id, {
      name: options.name,
      description: options.description,
      repository: `https://github.com/${options.repository}`,
      accessToken: options.githubToken.unsafeUnwrap(),
      iamServiceRole: options.roleArn,
      platform: 'WEB_COMPUTE', // Next.js SSR rather than a static export.
      environmentVariables: Object.entries(options.environment).map(([name, value]) => ({
        name,
        value,
      })),
      customRules: [
        // Amplify's default SPA rewrite would swallow Next's own routing; this only
        // rewrites what genuinely 404s at the CDN.
        { source: '/<*>', target: '/index.html', status: '404-200' },
      ],
      buildSpec: this.buildSpec(options.appDirectory),
    });

    app.applyRemovalPolicy(RemovalPolicy.DESTROY);
    return app;
  }

  /**
   * The pnpm monorepo build.
   *
   * `pnpm install` runs at the repository root because a workspace cannot be installed in
   * isolation, and `--filter` builds the workspace packages this app depends on before the
   * app itself — without that the app compiles against stale or missing `dist` output from
   * @catalograil/core, which is the failure mode that looks like a missing module.
   */
  private buildSpec(appDirectory: string): string {
    const appName = appDirectory.split('/').pop();
    return JSON.stringify(
      {
        version: 1,
        frontend: {
          phases: {
            preBuild: {
              commands: [
                'corepack enable',
                'corepack prepare pnpm@11.23.0 --activate',
                'pnpm install --frozen-lockfile',
              ],
            },
            build: {
              commands: [`pnpm --filter @catalograil/${appName}-app... build`],
            },
          },
          artifacts: {
            baseDirectory: `${appDirectory}/.next`,
            files: ['**/*'],
          },
          cache: {
            paths: ['node_modules/**/*', `${appDirectory}/.next/cache/**/*`],
          },
        },
      },
      null,
      2,
    );
  }
}
