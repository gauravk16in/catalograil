#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { resolveEnv, stackName } from '../lib/env.js';
import { DataStack } from '../stacks/data-stack.js';
import { NetworkStack } from '../stacks/network-stack.js';
import { QueueStack } from '../stacks/queue-stack.js';

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

new DataStack(app, stackName('Data', config), {
  env,
  config,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  ingestionQueueArn: queues.queues.ingestion.queueArn,
});

app.synth();
