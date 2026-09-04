import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../lib/env.js';

export interface QueueStackProps extends StackProps {
  readonly config: EnvConfig;
  /** Ops address for DLQ alarms. Without it the alarms exist but notify nobody. */
  readonly alarmEmail?: string;
}

/** The Phase 1 queues (T1.4). */
export const QUEUE_NAMES = [
  'ingestion',
  'enrichment',
  'embedding',
  'notification',
  'policy-check',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

interface QueueSpec {
  /** Must exceed the worker's own timeout, or a slow message is redelivered mid-flight. */
  readonly visibilityTimeout: Duration;
  readonly description: string;
}

const QUEUE_SPECS: Record<QueueName, QueueSpec> = {
  ingestion: {
    // A 500-row import finishes in well under a second, but the budget is 60 (T1.11) and
    // the visibility timeout has to cover the worst case, not the measured one.
    visibilityTimeout: Duration.minutes(15),
    description: 'CSV parse, validate and upsert',
  },
  enrichment: {
    visibilityTimeout: Duration.minutes(5),
    description: 'Claude metadata generation, batched 20 products per call',
  },
  embedding: {
    visibilityTimeout: Duration.minutes(5),
    description: 'Bedrock vector generation and searchable_units upsert',
  },
  notification: {
    visibilityTimeout: Duration.minutes(2),
    description: 'SES and WhatsApp delivery',
  },
  'policy-check': {
    visibilityTimeout: Duration.minutes(5),
    description: 'Weekly merchant policy URL validation',
  },
};

/**
 * T1.4 — one queue per pipeline stage, each with a dead-letter queue and an alarm.
 *
 * Rule 1 has no exceptions, so the DLQ and the alarm are built by the same private method
 * as the queue itself. There is no code path here that can produce a queue without them,
 * which is the point: "every queue has a DLQ" is a property of the construct rather than
 * something a reviewer has to check.
 */
export class QueueStack extends Stack {
  readonly queues: Record<QueueName, sqs.Queue> = {} as Record<QueueName, sqs.Queue>;
  readonly deadLetterQueues: Record<QueueName, sqs.Queue> = {} as Record<QueueName, sqs.Queue>;
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: QueueStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.alarmTopic = new sns.Topic(this, 'DlqAlarmTopic', {
      displayName: `CatalogRail ${config.name} dead-letter alarms`,
    });

    if (props.alarmEmail) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }

    for (const name of QUEUE_NAMES) {
      const { queue, deadLetterQueue } = this.createQueue(name, config);
      this.queues[name] = queue;
      this.deadLetterQueues[name] = deadLetterQueue;
    }

    /**
     * Lets the uploads bucket deliver ObjectCreated events (T1.11).
     *
     * Granted here, to the S3 service principal scoped to this account, rather than by
     * `bucket.addEventNotification` reaching across from the data stack. That grant would
     * write a policy naming the bucket ARN into this stack while the data stack already
     * depends on this one — a dependency cycle CDK refuses to synthesise. Conditioning on
     * the account rather than the bucket ARN is what keeps the reference one-directional.
     */
    this.queues.ingestion.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [this.queues.ingestion.queueArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
  }

  private createQueue(
    name: QueueName,
    config: EnvConfig,
  ): { queue: sqs.Queue; deadLetterQueue: sqs.Queue } {
    const spec = QUEUE_SPECS[name];
    const id = toPascalCase(name);

    const deadLetterQueue = new sqs.Queue(this, `${id}Dlq`, {
      queueName: `catalograil-${config.name}-${name}-dlq`,
      // Long enough that a poisoned message survives a weekend before anyone looks at it.
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const queue = new sqs.Queue(this, `${id}Queue`, {
      queueName: `catalograil-${config.name}-${name}`,
      visibilityTimeout: spec.visibilityTimeout,
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
    });

    /**
     * Alarms on any message at all, per T1.4. A single message in a dead-letter queue is
     * already a bug — a merchant's upload that vanished, or a product that never got
     * embedded — so the threshold is 0 rather than something that waits for a pattern.
     *
     * `treatMissingData: NOT_BREACHING` matters here: an empty DLQ reports no data rather
     * than zero, and the default would leave the alarm sitting in INSUFFICIENT_DATA
     * forever, which reads the same as broken.
     */
    const alarm = new cloudwatch.Alarm(this, `${id}DlqAlarm`, {
      alarmName: `catalograil-${config.name}-${name}-dlq-not-empty`,
      alarmDescription: `Messages in the ${name} dead-letter queue (${spec.description}).`,
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    return { queue, deadLetterQueue };
  }
}

function toPascalCase(value: string): string {
  return value
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
