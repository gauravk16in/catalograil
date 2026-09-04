import { Duration } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import {
  NodejsFunction,
  OutputFormat,
  type NodejsFunctionProps,
} from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EnvConfig } from './env.js';

/**
 * One place every Lambda is built, so the things that must be true of all of them are true
 * by construction rather than by remembering: ARM64, Powertools wired to a real service
 * name, log retention that does not accumulate forever, and X-Ray on.
 */

export interface FunctionOptions extends Partial<NodejsFunctionProps> {
  readonly config: EnvConfig;
  /** Path to the handler file, relative to the repo root. */
  readonly entry: string;
  readonly handlerName?: string;
  /** Omit for a function with no database access. */
  readonly vpc?: ec2.IVpc;
  readonly securityGroups?: ec2.ISecurityGroup[];
  readonly environment?: Record<string, string>;
}

export function createFunction(
  scope: Construct,
  id: string,
  options: FunctionOptions,
): NodejsFunction {
  const {
    config,
    entry,
    handlerName = 'handler',
    vpc,
    securityGroups,
    environment,
    bundling: bundlingOverride,
    ...rest
  } = options;

  return new NodejsFunction(scope, id, {
    entry,
    handler: handlerName,
    /**
     * Node 22, not the Node 20 named in context section 4.
     *
     * nodejs20.x was deprecated on 2026-04-30 and stops accepting new function creation on
     * 2027-02-01. Deploying onto it now would mean a forced migration within months, so
     * this takes the current LTS instead. Nothing in the codebase depends on the
     * difference — local development already runs Node 22.
     */
    runtime: lambda.Runtime.NODEJS_22_X,
    // Graviton: cheaper per millisecond, and nothing here is architecture-sensitive.
    architecture: lambda.Architecture.ARM_64,
    memorySize: 1024,
    timeout: Duration.seconds(30),
    /**
     * An explicit log group rather than `logRetention`, which is deprecated and works by
     * deploying an extra custom-resource Lambda per function purely to set a retention
     * value. This is the same outcome with one resource instead of two.
     */
    logGroup: new logs.LogGroup(scope, `${id}Logs`, {
      logGroupName: `/aws/lambda/${config.resourcePrefix}-${config.name}-${id.toLowerCase()}`,
      retention:
        config.name === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: config.name === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    }),
    tracing: lambda.Tracing.ACTIVE,
    ...(vpc ? { vpc, ...(securityGroups ? { securityGroups } : {}) } : {}),
    bundling: {
      format: OutputFormat.ESM,
      target: 'node22',
      minify: true,
      sourceMap: true,
      /**
       * The AWS SDK is bundled rather than taken from the runtime.
       *
       * The nodejs20.x runtime ships a subset of SDK v3 clients, and not all of the ones
       * used here — the Bedrock runtime client in particular. Excluding them would work
       * until it silently did not, so the bundle carries its own copy and the version is
       * whatever the lockfile says rather than whatever AWS shipped that month.
       */
      externalModules: [],
      // ESM needs these shims; several dependencies still reach for them.
      banner:
        "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" +
        "import{fileURLToPath as __fp}from'url';import{dirname as __dn}from'path';" +
        'const __filename=__fp(import.meta.url);const __dirname=__dn(__filename);',
      ...bundlingOverride,
    },
    environment: {
      NODE_OPTIONS: '--enable-source-maps',
      STAGE: config.name,
      POWERTOOLS_SERVICE_NAME: id,
      POWERTOOLS_LOG_LEVEL: config.name === 'prod' ? 'INFO' : 'DEBUG',
      // Metrics off until there is a dashboard to read them.
      POWERTOOLS_METRICS_NAMESPACE: 'CatalogRail',
      ...environment,
    },
    ...rest,
  });
}

/**
 * The database connection settings every VPC function needs.
 *
 * Rule 11: the host is always the proxy endpoint, never the cluster's. IAM auth means no
 * password is passed — `packages/db/src/client.ts` mints a token per connection.
 */
export function databaseEnvironment(
  proxyEndpoint: string,
  databaseName = 'catalograil',
): Record<string, string> {
  return {
    DATABASE_HOST: proxyEndpoint,
    DATABASE_PORT: '5432',
    DATABASE_NAME: databaseName,
    DATABASE_USER: 'catalograil',
    DATABASE_SSL: 'true',
    DATABASE_IAM_AUTH: 'true',
    DATABASE_MAX_CONNECTIONS: '5',
  };
}
