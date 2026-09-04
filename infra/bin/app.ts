#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { resolveEnv, stackName } from '../lib/env.js';
import { ApiStack } from '../stacks/api-stack.js';
import { DataStack } from '../stacks/data-stack.js';
import { AuthStack } from '../stacks/auth-stack.js';
import { FrontendStack } from '../stacks/frontend-stack.js';
import { NetworkStack } from '../stacks/network-stack.js';
import { QueueStack } from '../stacks/queue-stack.js';
import { WorkerStack } from '../stacks/worker-stack.js';

/**
 * CDK entrypoint.
 *
 * Stack order is a dependency chain, not a preference: the data stack wires the uploads
 * bucket's ObjectCreated notification to the ingestion queue, so queues exist first.
 *
 *   cdk deploy --all --context env=dev
 */
const app = new App();
const config = resolveEnv(app);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1', // D8: Mumbai primary
};

const network = new NetworkStack(app, stackName('Network', config), { env, config });

const queues = new QueueStack(app, stackName('Queue', config), {
  env,
  config,
  ...(process.env.OPS_ALARM_EMAIL ? { alarmEmail: process.env.OPS_ALARM_EMAIL } : {}),
});

const data = new DataStack(app, stackName('Data', config), {
  env,
  config,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  ingestionQueueArn: queues.queues.ingestion.queueArn,
});

const sesFromAddress = process.env.SES_FROM_ADDRESS ?? 'no-reply@catalograil.example';



const workers = new WorkerStack(app, stackName('Worker', config), {
  env,
  config,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  migrationSecurityGroup: data.migrationSecurityGroup,
  proxy: data.proxy,
  cluster: data.cluster,
  queues: queues.queues,
  uploadsBucket: data.uploadsBucket,
  exportsBucket: data.exportsBucket,
  sesFromAddress,
});

/**
 * Identity (DC1). Depends on the worker stack for its post-confirmation triggers, and the
 * API stack depends on it for the JWT authorizers — so the order is workers, auth, API.
 */
const auth = new AuthStack(app, stackName('Auth', config), {
  env,
  config,
  merchantPostConfirmation: workers.merchantPostConfirmation,
  buyerPostConfirmation: workers.buyerPostConfirmation,
});

const api = new ApiStack(app, stackName('Api', config), {
  env,
  config,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  proxy: data.proxy,
  uploadsBucket: data.uploadsBucket,
  queryCacheTable: data.tables.QueryCache!,
  searchLogsTable: data.tables.SearchLogs!,
  enrichmentQueue: queues.queues.enrichment,
  merchantPool: auth.merchantPool,
  merchantPoolClient: auth.merchantClient,
  buyerPool: auth.buyerPool,
  buyerPoolClient: auth.buyerClient,
});

/**
 * Only created when a GitHub token secret is named. The dashboards are Git-connected, and
 * a stack that cannot reach the repository would fail at deploy rather than at synth —
 * making it opt-in keeps `cdk synth` working for everyone, including CI with no token.
 */
const githubTokenSecretName = process.env.GITHUB_TOKEN_SECRET_NAME;
const githubRepository = process.env.GITHUB_REPOSITORY ?? 'gauravk16in/catalograil';

if (githubTokenSecretName) {
  new FrontendStack(app, stackName('Frontend', config), {
    env,
    config,
    apiBaseUrl: api.api.apiEndpoint,
    repository: githubRepository,
    githubTokenSecretName,
    merchantUserPoolId: auth.merchantPool.userPoolId,
    merchantUserPoolClientId: auth.merchantClient.userPoolClientId,
    buyerUserPoolId: auth.buyerPool.userPoolId,
    buyerUserPoolClientId: auth.buyerClient.userPoolClientId,
    ...(process.env.GITHUB_BRANCH ? { branch: process.env.GITHUB_BRANCH } : {}),
  });
}

app.synth();
