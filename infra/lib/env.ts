import type { App } from 'aws-cdk-lib';

export const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
export type EnvName = (typeof ENVIRONMENTS)[number];

export interface EnvConfig {
  readonly name: EnvName;
  /**
   * Prefix for every physical AWS resource name (queues, tables, log groups, KMS alias,
   * the DB proxy). Includes a short suffix derived from the account id so the same stack
   * definitions can be deployed into more than one AWS account side by side without a
   * naming collision — S3 bucket names already append the account id for the same reason,
   * but SQS queues, DynamoDB tables and the rest have no such requirement from AWS and
   * would otherwise collide silently between two accounts using the default name.
   */
  readonly resourcePrefix: string;
  /** Aurora Serverless v2 capacity range (context §10). */
  readonly auroraMinAcu: number;
  readonly auroraMaxAcu: number;
  /** Cold starts inside an MCP tool call are unacceptable in prod (T2.1). */
  readonly mcpProvisionedConcurrency: number;
  readonly razorpayLiveMode: boolean;
  /**
   * Browser origins allowed to call the API (S1.4).
   *
   * Explicit, never `*`. A wildcard is rejected outright by browsers on any credentialed
   * request, and it is also the wrong answer for an API that will carry merchant sessions.
   * Localhost is included outside prod so the dashboards can be developed against a
   * deployed backend without a second CORS configuration to keep in sync.
   *
   * Amplify domains are derived from the app id, which is not known until the Frontend
   * stack exists — and that stack depends on this one. So they are supplied through CDK
   * context (`-c appOrigins=https://a,https://b`) rather than by a stack reference, which
   * would be a dependency cycle.
   */
  readonly appOrigins: readonly string[];
}

const CONFIGS: Record<EnvName, Omit<EnvConfig, 'resourcePrefix' | 'appOrigins'>> = {
  dev: {
    name: 'dev',
    /**
     * Zero, not the 0.5 in context section 10.
     *
     * Serverless v2 scales to zero and auto-pauses, which takes a dev cluster from about
     * $44 a month sitting idle to near nothing. The cost is a few seconds on the first
     * query after a pause, which no dev workflow minds. Staging and prod keep the
     * capacities the context specifies.
     */
    auroraMinAcu: 0,
    auroraMaxAcu: 4,
    mcpProvisionedConcurrency: 0,
    razorpayLiveMode: false,
  },
  staging: {
    name: 'staging',
    auroraMinAcu: 0.5,
    auroraMaxAcu: 2,
    mcpProvisionedConcurrency: 0,
    razorpayLiveMode: false,
  },
  prod: {
    name: 'prod',
    auroraMinAcu: 1,
    auroraMaxAcu: 8,
    mcpProvisionedConcurrency: 2,
    razorpayLiveMode: true,
  },
};

export function resolveEnv(app: App): EnvConfig {
  const raw = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';
  const base = CONFIGS[raw as EnvName];
  if (!base) {
    throw new Error(`Unknown env "${raw}". Pass one of: ${ENVIRONMENTS.join(', ')}`);
  }

  const explicitPrefix = app.node.tryGetContext('resourcePrefix') as string | undefined;

  const contextOrigins = (app.node.tryGetContext('appOrigins') as string | undefined)
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const envOrigins = process.env.APP_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const appOrigins = contextOrigins ?? envOrigins ?? defaultOrigins(base.name);
  for (const origin of appOrigins) {
    if (origin === '*') {
      throw new Error(
        'appOrigins must never contain "*": a wildcard origin is rejected by browsers on ' +
          'credentialed requests and is not a valid gate for a session-bearing API.',
      );
    }
  }

  return { ...base, resourcePrefix: explicitPrefix ?? defaultResourcePrefix(), appOrigins };
}

/**
 * Localhost only, outside prod.
 *
 * Deployed dashboard origins are passed in per environment; a default that guessed at an
 * Amplify domain would be wrong the moment an app is recreated with a new id, and wrong
 * silently — CORS failures do not name the origin they rejected.
 */
function defaultOrigins(env: EnvName): readonly string[] {
  if (env === 'prod') return ['https://merchant.catalograil.com', 'https://app.catalograil.com'];
  return ['http://localhost:3000', 'http://localhost:3001'];
}

/** `catalograil-<6 hex chars of the account id>`, so two accounts never collide. */
function defaultResourcePrefix(): string {
  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const suffix = account ? account.slice(-6) : 'local';
  return `catalograil-${suffix}`;
}

/** Stack names are env-suffixed so all three can coexist in one account. */
export function stackName(base: string, env: EnvConfig): string {
  return `CatalogRail-${base}-${env.name}`;
}
