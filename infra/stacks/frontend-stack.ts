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
        /**
         * The branch name is sanitised, not used raw. Amplify derives the subdomain by
         * replacing anything that cannot appear in a hostname — a branch like
         * `phase-1/complete` becomes `phase-1-complete` — so emitting the raw name here
         * produced a URL with a slash in the host that resolved to nothing.
         */
        value: `https://${branch.replace(/[^a-zA-Z0-9-]/g, '-')}.${app.attrDefaultDomain}`,
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
      /**
       * `WEB`, not `WEB_COMPUTE`. Both apps are `output: 'export'` static bundles — every
       * page is a client component calling the API — so there is no Node runtime to host.
       * WEB_COMPUTE would deploy a server that has nothing to do, and its runtime expects a
       * real `node_modules` in the app directory, which a pnpm workspace does not produce.
       */
      platform: 'WEB',
      environmentVariables: Object.entries({
        ...options.environment,
        // Amplify uses this to locate the app inside the monorepo; the buildSpec's appRoot
        // alone is not enough for its framework detection.
        AMPLIFY_MONOREPO_APP_ROOT: options.appDirectory,
        AMPLIFY_DIFF_DEPLOY: 'false',
      }).map(([name, value]) => ({ name, value })),
      customRules: [
        /**
         * Client-side routing on static hosting. Next exports a file per route, so a direct
         * hit on /products resolves normally; this only catches paths the CDN genuinely
         * cannot find, returning the shell with a 200 so the router can take over rather
         * than the browser showing a 404.
         */
        {
          source: '/<*>',
          target: '/index.html',
          status: '404-200',
        },
      ],
      buildSpec: this.buildSpec(options.appDirectory),
    });

    app.applyRemovalPolicy(RemovalPolicy.DESTROY);
    return app;
  }

  /**
   * The pnpm monorepo build.
   *
   * Two things here are not obvious and both were found by a failed deploy.
   *
   * First, the spec uses Amplify's `applications`/`appRoot` form rather than the plain
   * `frontend` form with a path-prefixed baseDirectory. That is what tells Amplify this is
   * a monorepo app, and it is the trigger for running its Next.js adapter inside that root.
   * Without it the build succeeds and the *deploy* fails with "Failed to find the
   * deploy-manifest.json file" — the adapter that produces that manifest never ran.
   *
   * Second, install happens from the repository root: a pnpm workspace cannot be installed
   * in isolation. `--filter ...^...` then builds only this app's workspace dependencies,
   * so @catalograil/core and friends have real dist output before Next compiles against
   * them — otherwise the failure looks like a missing module rather than a build order
   * problem.
   */
  private buildSpec(appDirectory: string): string {
    const appName = appDirectory.split('/').pop();
    const depth = appDirectory.split('/').length;
    const toRoot = Array(depth).fill('..').join('/');

    return JSON.stringify(
      {
        version: 1,
        applications: [
          {
            appRoot: appDirectory,
            frontend: {
              phases: {
                preBuild: {
                  commands: [
                    `cd ${toRoot}`,
                    'corepack enable',
                    'corepack prepare pnpm@11.23.0 --activate',
                    'pnpm install --frozen-lockfile',
                    // Dependencies only; Amplify builds the app itself in the build phase.
                    `pnpm --filter @catalograil/${appName}-app^... build`,
                    `cd ${appDirectory}`,
                  ],
                },
                build: { commands: ['npx next build'] },
              },
              artifacts: {
                // `out`, not `.next`: this is a static export. Relative to appRoot, which
                // is what the `applications` form expects.
                baseDirectory: 'out',
                files: ['**/*'],
              },
              cache: {
                paths: [`${toRoot}/node_modules/**/*`, '.next/cache/**/*'],
              },
            },
          },
        ],
      },
      null,
      2,
    );
  }
}
