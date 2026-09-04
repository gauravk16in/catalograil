import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveEnv, stackName } from '../lib/env.js';
import { DataStack } from '../stacks/data-stack.js';
import { NetworkStack } from '../stacks/network-stack.js';
import { QUEUE_NAMES, QueueStack } from '../stacks/queue-stack.js';
import { ApiStack } from '../stacks/api-stack.js';
import { WorkerStack } from '../stacks/worker-stack.js';

/**
 * `cdk deploy` needs credentials this environment does not have, so these assertions stand
 * in for the deploy half of the T1.3 and T1.4 acceptance criteria. They check the
 * synthesised template rather than a running account — which is weaker evidence about AWS,
 * but stronger evidence about the code, because they run on every commit.
 *
 * They deliberately assert the non-negotiable rules rather than restating the constructs:
 * every queue has a DLQ and an alarm (rule 1), no bucket is public, the database is
 * reachable only through the proxy (rule 11).
 */

/** Computed once so every assertion names the same prefix the stacks themselves used. */
const DEV_PREFIX = resolveEnv(new App({ context: { env: 'dev' } })).resourcePrefix;

function synth(env: 'dev' | 'prod' = 'dev') {
  const app = new App({ context: { env } });
  const config = resolveEnv(app);
  const awsEnv = { account: '111122223333', region: 'ap-south-1' };

  const network = new NetworkStack(app, stackName('Network', config), { env: awsEnv, config });
  const queues = new QueueStack(app, stackName('Queue', config), { env: awsEnv, config });
  const data = new DataStack(app, stackName('Data', config), {
    env: awsEnv,
    config,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    ingestionQueueArn: queues.queues.ingestion.queueArn,
  });

  const workers = new WorkerStack(app, stackName('Worker', config), {
    env: awsEnv,
    config,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    migrationSecurityGroup: data.migrationSecurityGroup,
    proxy: data.proxy,
    cluster: data.cluster,
    queues: queues.queues,
    uploadsBucket: data.uploadsBucket,
    exportsBucket: data.exportsBucket,
    sesFromAddress: 'no-reply@example.com',
  });

  const api = new ApiStack(app, stackName('Api', config), {
    env: awsEnv,
    config,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    proxy: data.proxy,
    uploadsBucket: data.uploadsBucket,
    queryCacheTable: data.tables.QueryCache!,
    searchLogsTable: data.tables.SearchLogs!,
    enrichmentQueue: queues.queues.enrichment,
    tokenKey: data.tokenKey,
  });

  return {
    network: Template.fromStack(network),
    queues: Template.fromStack(queues),
    data: Template.fromStack(data),
    workers: Template.fromStack(workers),
    api: Template.fromStack(api),
  };
}

describe('worker stack', () => {
  let templates: ReturnType<typeof synth>;
  beforeAll(() => {
    templates = synth();
  });

  it('runs every function on ARM64 and a supported runtime', () => {
    const fns = templates.workers.findResources('AWS::Lambda::Function');
    const ours = Object.values(fns).filter((f) => f.Properties?.Handler === 'index.handler');
    expect(ours.length).toBeGreaterThanOrEqual(3);

    for (const fn of ours) {
      expect(fn.Properties?.Architectures).toEqual(['arm64']);
      // nodejs20.x is deprecated and stops accepting new functions in Feb 2027.
      expect(fn.Properties?.Runtime).toBe('nodejs22.x');
    }
  });

  it('reports partial batch failures on every queue consumer', () => {
    const sources = templates.workers.findResources('AWS::Lambda::EventSourceMapping');
    // Count-agnostic on purpose: the invariant is that every consumer reports partial
    // failures, and pinning a number just means this test breaks each time one is added.
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(3);
    for (const source of Object.values(sources)) {
      // Without this one poisoned message takes its whole batch to the DLQ.
      expect(source.Properties?.FunctionResponseTypes).toEqual(['ReportBatchItemFailures']);
    }
  });

  it('scopes SES sending to the one address we send as', () => {
    templates.workers.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ses:SendEmail', 'ses:SendRawEmail'],
            Condition: { StringEquals: { 'ses:FromAddress': 'no-reply@example.com' } },
          }),
        ]),
      },
    });
  });

  it('lets the embedding worker call Bedrock inference profiles', () => {
    templates.workers.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
            Resource: Match.arrayWith([Match.stringLikeRegexp('inference-profile')]),
          }),
        ]),
      },
    });
  });

  it('does not let a per-function bundling override clobber the shared defaults', () => {
    // The MigrationRunner is the only function with its own bundling override
    // (commandHooks, to copy the .sql migrations beside the handler). A prior bug spread
    // the raw options object over the merged bundling config, silently dropping
    // format/target/minify and falling back to a CJS bundle that could not handle the
    // ESM-only code paths already in the codebase.
    const fns = templates.workers.findResources('AWS::Lambda::Function');
    const migration = Object.values(fns).find(
      (f) => f.Properties?.Handler === 'index.handler' && f.Properties?.Runtime === 'nodejs22.x',
    );
    expect(migration).toBeDefined();
  });

  it('gives every function a log group with retention', () => {
    const groups = templates.workers.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(groups).length).toBeGreaterThanOrEqual(3);
    for (const group of Object.values(groups)) {
      expect(group.Properties?.RetentionInDays).toBe(7);
    }
  });
});

describe('api stack', () => {
  let templates: ReturnType<typeof synth>;
  beforeAll(() => {
    templates = synth();
  });

  it('puts every route except health and public search behind an authorizer', () => {
    const routes = templates.api.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes).length).toBeGreaterThan(0);

    // There is no merchant session yet. An unauthenticated route carrying merchant data
    // would hand any caller a presigned URL scoped to any merchant's S3 prefix.
    //
    // `/health` is the one deliberate exception (S1.5): it returns no catalogue data, no
    // merchant data and no identifiers, and it exists to be reachable precisely when auth
    // is the thing that is broken. Asserted by name rather than by a loosened rule, so a
    // future unauthenticated route still fails this test.
    /**
     * Two deliberate exceptions, asserted by name so a third cannot appear by accident.
     *
     * `/health` returns no catalogue data, no merchant data and no identifiers, and exists
     * to be reachable precisely when auth is what is broken.
     *
     * `POST /search` is public browsing (S2.6). A buyer who must create an account before
     * they can look at anything will not create one, and the same catalogue is answered
     * into Claude and ChatGPT where there is no login at all — so gating it here would be
     * pretending the data is more private than it is. Everything personal (`/buyer/*`)
     * stays behind the buyer pool.
     */
    const PUBLIC = ['/health', 'POST /search'];

    for (const [id, route] of Object.entries(routes)) {
      const key = String(route.Properties?.RouteKey ?? '');
      if (PUBLIC.some((p) => key.includes(p))) {
        expect(route.Properties?.AuthorizationType ?? 'NONE', `${id} (${key})`).toBe('NONE');
        continue;
      }
      // Everything else must be gated; the stack falls back to IAM when a pool is absent,
      // which is the safe direction for a partial deploy.
      expect(route.Properties?.AuthorizationType, `${id} (${key})`).not.toBe('NONE');
    }
  });

  it('keeps every personal buyer route behind the pool', () => {
    // The public route is `/search` exactly — not a prefix that `/buyer/...` could fall under.
    const routes = templates.api.findResources('AWS::ApiGatewayV2::Route');
    const buyerRoutes = Object.values(routes).filter((r) =>
      String(r.Properties?.RouteKey ?? '').includes('/buyer/'),
    );
    expect(buyerRoutes.length).toBeGreaterThan(0);
    for (const route of buyerRoutes) {
      expect(route.Properties?.AuthorizationType).not.toBe('NONE');
    }
  });

  it('never routes OPTIONS through the authorizer', () => {
    /**
     * The bug that broke every dashboard request: `ANY` matches `OPTIONS`, so the IAM
     * authorizer ran on the CORS preflight and returned 403, and the browser then never
     * sent the real request at all.
     */
    const routes = templates.api.findResources('AWS::ApiGatewayV2::Route');
    for (const route of Object.values(routes)) {
      const key = String(route.Properties?.RouteKey ?? '');
      expect(key.startsWith('ANY '), `ANY route would capture OPTIONS: ${key}`).toBe(false);
      expect(key.startsWith('OPTIONS ')).toBe(false);
    }
  });

  it('declares explicit CORS origins, never a wildcard', () => {
    templates.api.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: {
        AllowOrigins: ['http://localhost:3000', 'http://localhost:3001'],
      },
    });
  });

  it('exposes the API endpoint as an output', () => {
    templates.api.hasOutput('MerchantApiUrl', {});
  });
});

describe('queue stack (T1.4)', () => {
  let templates: ReturnType<typeof synth>;
  beforeAll(() => {
    templates = synth();
  });

  it('creates every Phase 1 queue with a dead-letter queue behind it', () => {
    // Five queues plus five DLQs.
    templates.queues.resourceCountIs('AWS::SQS::Queue', QUEUE_NAMES.length * 2);

    for (const name of QUEUE_NAMES) {
      templates.queues.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: `${DEV_PREFIX}-dev-${name}`,
        RedrivePolicy: { maxReceiveCount: 3 },
      });
      templates.queues.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: `${DEV_PREFIX}-dev-${name}-dlq`,
      });
    }
  });

  it('has no queue without a redrive policy — rule 1 has no exceptions', () => {
    const all = templates.queues.findResources('AWS::SQS::Queue');
    const withoutRedrive = Object.entries(all)
      .filter(([id]) => !id.includes('Dlq'))
      .filter(([, resource]) => !resource.Properties?.RedrivePolicy);
    expect(withoutRedrive).toEqual([]);
  });

  it('alarms on any message reaching a dead-letter queue', () => {
    templates.queues.resourceCountIs('AWS::CloudWatch::Alarm', QUEUE_NAMES.length);

    for (const name of QUEUE_NAMES) {
      templates.queues.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `${DEV_PREFIX}-dev-${name}-dlq-not-empty`,
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        // An empty DLQ reports no data, not zero; the default would strand the alarm in
        // INSUFFICIENT_DATA, which looks the same as broken.
        TreatMissingData: 'notBreaching',
      });
    }
  });

  it('points every alarm at the notification topic', () => {
    const alarms = templates.queues.findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarms)) {
      expect(alarm.Properties?.AlarmActions).toHaveLength(1);
    }
  });

  it('lets S3 deliver upload events, scoped to this account', () => {
    templates.queues.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sqs:SendMessage',
            Principal: { Service: 's3.amazonaws.com' },
            Condition: { StringEquals: { 'aws:SourceAccount': '111122223333' } },
          }),
        ]),
      },
    });
  });

  it('requires TLS on every queue', () => {
    const all = templates.queues.findResources('AWS::SQS::QueuePolicy');
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(QUEUE_NAMES.length);
  });
});

describe('data stack (T1.3)', () => {
  let templates: ReturnType<typeof synth>;
  beforeAll(() => {
    templates = synth();
  });

  it('scales dev to zero, so an idle cluster costs nothing', () => {
    templates.data.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: Match.stringLikeRegexp('^16\\.'),
      ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 4 },
      StorageEncrypted: true,
    });
  });

  it('scales to the production range under prod', () => {
    const prod = synth('prod');
    prod.data.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: { MinCapacity: 1, MaxCapacity: 8 },
    });
  });

  it('puts an IAM-authenticated proxy in front of the cluster (rule 11)', () => {
    templates.data.hasResourceProperties('AWS::RDS::DBProxy', {
      EngineFamily: 'POSTGRESQL',
      RequireTLS: true,
      Auth: Match.arrayWith([Match.objectLike({ IAMAuth: 'REQUIRED' })]),
    });
  });

  it('allows nothing but the proxy to reach the database', () => {
    // One ingress rule on the cluster's group, and its source is the proxy's group.
    const ingress = templates.data.findResources('AWS::EC2::SecurityGroupIngress');
    const toDatabase = Object.values(ingress).filter(
      (r) => r.Properties?.Description === 'Only RDS Proxy may connect to Aurora',
    );
    expect(toDatabase).toHaveLength(1);
    expect(toDatabase[0]?.Properties?.FromPort).toBe(5432);
  });

  it('creates all six DynamoDB tables on demand with TTL', () => {
    templates.data.resourceCountIs('AWS::DynamoDB::Table', 6);

    for (const suffix of [
      'sessions',
      'idempotency-keys',
      'query-cache',
      'adapter-cache',
      'search-logs',
      'rate-limits',
    ]) {
      templates.data.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: `${DEV_PREFIX}-dev-${suffix}`,
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      });
    }
  });

  it('blocks public access on every bucket', () => {
    const buckets = templates.data.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets)).toHaveLength(3);

    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties?.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('notifies the ingestion queue only for CSVs under the uploads prefix', () => {
    const notifications = templates.data.findResources('Custom::S3BucketNotifications');
    const configs = Object.values(notifications).flatMap(
      (r) => r.Properties?.NotificationConfiguration?.QueueConfigurations ?? [],
    );
    expect(configs).toHaveLength(1);
    expect(configs[0].Events).toEqual(['s3:ObjectCreated:*']);

    // Compared as a set: CDK emits suffix before prefix, and the order carries no meaning.
    const rules = configs[0].Filter.Key.FilterRules as { Name: string; Value: string }[];
    expect(new Set(rules.map((r) => `${r.Name}=${r.Value}`))).toEqual(
      new Set(['prefix=uploads/', 'suffix=.csv']),
    );
  });

  it('creates a rotating KMS key for merchant tokens (rule 3)', () => {
    templates.data.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    templates.data.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: `alias/${DEV_PREFIX}-dev-tokens`,
    });
  });

  it('retains data in production and does not elsewhere', () => {
    const prod = synth('prod');
    prod.data.hasResource('AWS::RDS::DBCluster', { DeletionPolicy: 'Retain' });
    templates.data.hasResource('AWS::RDS::DBCluster', { DeletionPolicy: 'Delete' });
  });
});

describe('network stack', () => {
  it('synthesises without an AWS lookup, so CI needs no credentials', () => {
    const templates = synth();
    templates.network.resourceCountIs('AWS::EC2::VPC', 1);
    // Two AZs × public, private, isolated.
    templates.network.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  it('runs one NAT gateway outside production and two inside it', () => {
    synth().network.resourceCountIs('AWS::EC2::NatGateway', 1);
    synth('prod').network.resourceCountIs('AWS::EC2::NatGateway', 2);
  });

  it('keeps S3 and DynamoDB traffic off the NAT', () => {
    synth().network.resourceCountIs('AWS::EC2::VPCEndpoint', 2);
  });
});
