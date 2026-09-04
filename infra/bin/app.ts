#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { resolveEnv } from '../lib/env.js';

/**
 * CDK entrypoint. Stacks are added as their phase-1 tasks land:
 *   T1.3 DataStack   — Aurora + pgvector, DynamoDB, S3, KMS
 *   T1.4 QueueStack  — SQS with a DLQ and alarm on every queue
 *        ApiStack, McpStack, WorkerStack
 */
const app = new App();
const env = resolveEnv(app);

const awsEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1', // D8: Mumbai primary
};

void awsEnv;
void env;

app.synth();
