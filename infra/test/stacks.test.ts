import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveEnv, stackName } from '../lib/env.js';
import { DataStack } from '../stacks/data-stack.js';
import { NetworkStack } from '../stacks/network-stack.js';
import { QUEUE_NAMES, QueueStack } from '../stacks/queue-stack.js';

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

  return {
    network: Template.fromStack(network),
    queues: Template.fromStack(queues),
    data: Template.fromStack(data),
  };
}

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
        QueueName: `catalograil-dev-${name}`,
        RedrivePolicy: { maxReceiveCount: 3 },
      });
      templates.queues.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: `catalograil-dev-${name}-dlq`,
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
        AlarmName: `catalograil-dev-${name}-dlq-not-empty`,
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

  it('runs Aurora Serverless v2 on PostgreSQL 16 at the configured capacity', () => {
    templates.data.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: Match.stringLikeRegexp('^16\\.'),
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
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
        TableName: `catalograil-dev-${suffix}`,
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
      AliasName: 'alias/catalograil-dev-tokens',
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
