import * as path from 'node:path';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../lib/env.js';
import { createFunction, databaseEnvironment } from '../lib/lambda.js';
import type { QueueName } from './queue-stack.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

export interface WorkerStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly vpc: ec2.IVpc;
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  /** Created in the data stack, beside the group it is allowed through. */
  readonly migrationSecurityGroup: ec2.ISecurityGroup;
  readonly proxy: rds.DatabaseProxy;
  readonly cluster: rds.DatabaseCluster;
  readonly queues: Record<QueueName, sqs.IQueue>;
  readonly uploadsBucket: s3.IBucket;
  readonly exportsBucket: s3.IBucket;
  readonly sesFromAddress: string;
}

/**
 * The SQS consumers, plus the migration function.
 *
 * Every consumer reports partial batch failures. Without that, one poisoned message drags
 * its nine healthy neighbours to the dead-letter queue with it, and the alarm that fires
 * points at the wrong thing.
 */
export class WorkerStack extends Stack {
  readonly migrationFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);

    const { config, vpc, lambdaSecurityGroup, proxy } = props;
    const dbEnv = databaseEnvironment(proxy.endpoint);

    // ── Ingestion (T1.11) ───────────────────────────────────────────────────────
    const ingestion = createFunction(this, 'IngestionWorker', {
      config,
      entry: path.join(REPO_ROOT, 'services/workers/ingestion/src/handler.ts'),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      // A 500-row file imports in well under a second, but the T1.11 budget is 60 and the
      // timeout has to cover the worst case, not the measured one.
      timeout: Duration.minutes(5),
      memorySize: 1536,
      environment: {
        ...dbEnv,
        S3_BUCKET_UPLOADS: props.uploadsBucket.bucketName,
        S3_BUCKET_EXPORTS: props.exportsBucket.bucketName,
        SQS_QUEUE_ENRICHMENT: props.queues.enrichment.queueUrl,
        SES_FROM_ADDRESS: props.sesFromAddress,
      },
    });

    ingestion.addEventSource(
      new SqsEventSource(props.queues.ingestion, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    props.uploadsBucket.grantRead(ingestion);
    props.exportsBucket.grantWrite(ingestion);
    props.queues.enrichment.grantSendMessages(ingestion);
    grantDatabase(proxy, ingestion);
    grantSesSend(ingestion, props.sesFromAddress);

    // ── Embedding (T1.15) ───────────────────────────────────────────────────────
    const embedding = createFunction(this, 'EmbeddingWorker', {
      config,
      entry: path.join(REPO_ROOT, 'services/workers/embedding/src/handler.ts'),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.minutes(5),
      memorySize: 1536,
      environment: {
        ...dbEnv,
        BEDROCK_REGION: this.region,
        // Verified by T1.2. The bare model id refuses on-demand invocation; this is the
        // inference profile that fronts it. See packages/embeddings/MODELS.md.
        BEDROCK_TEXT_EMBED_MODEL_ID: 'global.cohere.embed-v4:0',
        BEDROCK_IMAGE_EMBED_MODEL_ID: 'global.cohere.embed-v4:0',
      },
    });

    embedding.addEventSource(
      new SqsEventSource(props.queues.embedding, {
        // Several products per invocation share one image cache, and merchants reuse a
        // photo across every variant.
        batchSize: 5,
        maxBatchingWindow: Duration.seconds(10),
        reportBatchItemFailures: true,
      }),
    );

    grantDatabase(proxy, embedding);
    grantBedrock(embedding);

    // ── Enrichment (T1.13) ──────────────────────────────────────────────────────
    const enrichment = createFunction(this, 'EnrichmentWorker', {
      config,
      entry: path.join(REPO_ROOT, 'services/workers/enrichment/src/handler.ts'),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: {
        ...dbEnv,
        SQS_QUEUE_EMBEDDING: props.queues.embedding.queueUrl,
        BEDROCK_REGION: this.region,
        // Verified callable on this account by T1.2. Claude on Bedrock refuses on-demand
        // invocation by bare model id, so this is the inference profile.
        ANTHROPIC_ENRICHMENT_MODEL: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    });

    enrichment.addEventSource(
      new SqsEventSource(props.queues.enrichment, {
        /**
         * Twenty, matching ENRICHMENT_BATCH_SIZE: the worker turns one batch into one
         * Claude call, so the event source's batch size *is* the model batch size. A
         * smaller number here would quietly multiply the cost of every import.
         */
        batchSize: 20,
        maxBatchingWindow: Duration.seconds(30),
        reportBatchItemFailures: true,
      }),
    );

    grantDatabase(proxy, enrichment);
    props.queues.embedding.grantSendMessages(enrichment);
    // Claude runs on Bedrock, so enrichment needs the same grant the embedding worker has
    // rather than a secret holding an Anthropic key.
    grantBedrock(enrichment);

    // ── Migration (operational, not a queue consumer) ───────────────────────────
    /**
     * Invoked on demand after a deploy. It is here rather than in the data stack because
     * it is compute, and it gets its own security group so the administrative path into
     * the cluster is separate from the application's — the app reaches Postgres only
     * through the proxy (rule 11), while this one connects directly to run DDL.
     */
    this.migrationFunction = createFunction(this, 'MigrationRunner', {
      config,
      entry: path.join(REPO_ROOT, 'packages/db/src/migrate-handler.ts'),
      vpc,
      securityGroups: [props.migrationSecurityGroup],
      // Creating HNSW indexes on a populated table is slow, and a cold Serverless v2
      // cluster resuming from zero ACU adds to the front of it.
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        DB_SECRET_ARN: props.cluster.secret!.secretArn,
        DB_CLUSTER_ENDPOINT: props.cluster.clusterEndpoint.hostname,
        DATABASE_NAME: 'catalograil',
      },
      bundling: {
        /**
         * The migrations are `.sql` files, which esbuild does not bundle. Copying them
         * beside the handler keeps the deployed function and the repository applying the
         * same migration list, rather than a hand-maintained copy.
         */
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${path.join(inputDir, 'packages/db/migrations')} ${outputDir}/migrations`,
          ],
        },
      },
    });

    props.cluster.secret!.grantRead(this.migrationFunction);
  }
}

/**
 * IAM auth to the proxy. Grants the token-generation permission and the network path; the
 * `rds_iam` grant inside Postgres is done by the migration function.
 */
function grantDatabase(proxy: rds.DatabaseProxy, fn: lambda.Function): void {
  proxy.grantConnect(fn, 'catalograil');
}

function grantBedrock(fn: lambda.Function): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      // Embed v4 is reached through a global inference profile, which can route the
      // request to any region — so the resource cannot be pinned to this one.
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        'arn:aws:bedrock:*:*:inference-profile/*',
      ],
    }),
  );
}

function grantSesSend(fn: lambda.Function, fromAddress: string): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
      // Scoped to the one address we send as, so a compromised function cannot send as
      // anyone else in the account.
      conditions: { StringEquals: { 'ses:FromAddress': fromAddress } },
    }),
  );
}
