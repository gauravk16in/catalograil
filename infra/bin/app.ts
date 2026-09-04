#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { resolveEnv, stackName } from '../lib/env.js';
import { ApiStack } from '../stacks/api-stack.js';
import { DataStack } from '../stacks/data-stack.js';
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

new WorkerStack(app, stackName('Worker', config), {
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

new ApiStack(app, stackName('Api', config), {
  env,
  config,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  proxy: data.proxy,
  uploadsBucket: data.uploadsBucket,
});

app.synth();
