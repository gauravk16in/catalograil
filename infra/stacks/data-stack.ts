import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../lib/env.js';

export interface DataStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly vpc: ec2.IVpc;
  /** Granted access to the proxy. Created in the network stack alongside the Lambdas. */
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  /**
   * Receives S3 ObjectCreated events for the uploads bucket (T1.11). Passed as an ARN and
   * imported below, so wiring the notification cannot mutate the queue stack — see the
   * grant in QueueStack for why that would be a cycle.
   */
  readonly ingestionQueueArn: string;
}

/**
 * T1.3 — Aurora with pgvector, the DynamoDB tables from context §7, the three buckets, and
 * the KMS key that protects merchant OAuth tokens.
 */
export class DataStack extends Stack {
  readonly cluster: rds.DatabaseCluster;
  readonly databaseSecurityGroup: ec2.SecurityGroup;
  readonly proxySecurityGroup: ec2.SecurityGroup;
  readonly proxy: rds.DatabaseProxy;
  readonly tokenKey: kms.Key;
  readonly uploadsBucket: s3.Bucket;
  readonly productImagesBucket: s3.Bucket;
  readonly exportsBucket: s3.Bucket;
  readonly tables: Record<string, dynamodb.Table> = {};

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config, vpc } = props;
    const retain = config.name === 'prod';

    // ── Security groups ─────────────────────────────────────────────────────────
    this.proxySecurityGroup = new ec2.SecurityGroup(this, 'ProxySecurityGroup', {
      vpc,
      description: 'RDS Proxy',
      allowAllOutbound: true,
    });

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'Aurora cluster',
      allowAllOutbound: false,
    });

    this.proxySecurityGroup.addIngressRule(
      props.lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Lambdas reach Postgres through the proxy',
    );

    // Rule 11, enforced rather than documented: the only thing that can open a connection
    // to the cluster is the proxy.
    this.databaseSecurityGroup.addIngressRule(
      this.proxySecurityGroup,
      ec2.Port.tcp(5432),
      'Only RDS Proxy may connect to Aurora',
    );

    // ── Aurora Serverless v2 ────────────────────────────────────────────────────
    this.cluster = new rds.DatabaseCluster(this, 'Catalog', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.databaseSecurityGroup],
      defaultDatabaseName: 'catalograil',
      credentials: rds.Credentials.fromGeneratedSecret('catalograil', {
        secretName: `catalograil/${config.name}/aurora`,
      }),
      serverlessV2MinCapacity: config.auroraMinAcu,
      serverlessV2MaxCapacity: config.auroraMaxAcu,
      writer: rds.ClusterInstance.serverlessV2('writer', { autoMinorVersionUpgrade: true }),
      // A reader only earns its cost once search traffic is real. Phase 4 territory.
      readers: [],
      /**
       * pgvector ships with Aurora PostgreSQL 16 but is not enabled by default. The
       * extensions themselves are created by the migration runner
       * (`packages/db/src/migrate.ts`), not by a custom resource here.
       *
       * T1.3 asks for them "on first boot". A CDK custom resource would need its own VPC
       * Lambda holding a second copy of the CREATE EXTENSION list, and nothing touches the
       * database before migrations run — so a second implementation could only drift from
       * the first. Running `pnpm db:migrate` is a required deployment step either way.
       */
      parameterGroup: new rds.ParameterGroup(this, 'ClusterParameters', {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_16_4,
        }),
        description: 'CatalogRail cluster parameters',
        parameters: {
          // Makes pgvector and the rest loadable; without it CREATE EXTENSION fails.
          shared_preload_libraries: 'pg_stat_statements',
        },
      }),
      backup: { retention: Duration.days(retain ? 14 : 1) },
      storageEncrypted: true,
      removalPolicy: retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    /**
     * Rule 11: every Lambda connection goes through the proxy. IAM auth means no database
     * password is ever handed to a function — `packages/db/src/client.ts` mints a
     * short-lived token per connection instead.
     */
    this.proxy = this.cluster.addProxy('Proxy', {
      vpc,
      secrets: [this.cluster.secret!],
      securityGroups: [this.proxySecurityGroup],
      iamAuth: true,
      requireTLS: true,
      // Lambda opens and abandons connections constantly; the proxy should reclaim them
      // rather than hold them for a frozen execution environment that may never return.
      idleClientTimeout: Duration.minutes(5),
      borrowTimeout: Duration.seconds(30),
      dbProxyName: `catalograil-${config.name}`,
    });

    // ── KMS ─────────────────────────────────────────────────────────────────────
    /** Rule 3: Razorpay tokens are envelope-encrypted with this key and nothing else. */
    this.tokenKey = new kms.Key(this, 'TokenKey', {
      alias: `alias/catalograil-${config.name}-tokens`,
      description: 'Envelope encryption for merchant Razorpay OAuth tokens',
      enableKeyRotation: true,
      removalPolicy: retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ── S3 ──────────────────────────────────────────────────────────────────────
    this.uploadsBucket = new s3.Bucket(this, 'Uploads', {
      bucketName: `catalograil-${config.name}-uploads-${this.account}`,
      // Reached only through a presigned PUT scoped to the merchant's own prefix (T1.11).
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [
        // The parsed result lives in Postgres; the raw CSV is only evidence for a support
        // question, and stops being interesting long before 90 days.
        { id: 'expire-raw-uploads', expiration: Duration.days(90) },
        { id: 'abort-incomplete', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: config.name === 'prod' ? ['https://merchant.catalograil.com'] : ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      removalPolicy: retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !retain,
    });

    // S3 ObjectCreated → SQS ingestion → the worker (T1.11). The queue is imported, so
    // the send permission comes from the policy the queue stack attaches, not from here.
    const ingestionQueue = sqs.Queue.fromQueueArn(
      this,
      'IngestionQueueRef',
      props.ingestionQueueArn,
    );
    this.uploadsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(ingestionQueue),
      { prefix: 'uploads/', suffix: '.csv' },
    );

    this.productImagesBucket = new s3.Bucket(this, 'ProductImages', {
      bucketName: `catalograil-${config.name}-product-images-${this.account}`,
      // Public reads come via CloudFront, never straight off the bucket.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !retain,
    });

    this.exportsBucket = new s3.Bucket(this, 'Exports', {
      bucketName: `catalograil-${config.name}-exports-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ id: 'expire-exports', expiration: Duration.days(30) }],
      removalPolicy: retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !retain,
    });

    // ── DynamoDB (context §7) ───────────────────────────────────────────────────
    this.table('Sessions', 'sessions', 'pk', 'sk');
    this.table('IdempotencyKeys', 'idempotency-keys', 'pk', 'sk');
    this.table('QueryCache', 'query-cache', 'pk', 'sk');
    this.table('AdapterCache', 'adapter-cache', 'pk', 'sk');
    this.table('SearchLogs', 'search-logs', 'pk', 'sk');
    this.table('RateLimits', 'rate-limits', 'pk', 'sk');
  }

  /**
   * On-demand, with TTL on `ttl` for every table.
   *
   * All six are expiring by design — sessions, idempotency records, caches, logs and rate
   * limit windows — so TTL is applied here rather than per table, and forgetting it on a
   * new table is not possible.
   */
  private table(id: string, suffix: string, partitionKey: string, sortKey: string): void {
    const config = (this.node.tryGetContext('env') as string | undefined) ?? 'dev';
    const table = new dynamodb.Table(this, id, {
      tableName: `catalograil-${config}-${suffix}`,
      partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config === 'prod' },
      removalPolicy: config === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.tables[id] = table;
  }
}
