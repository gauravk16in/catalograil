import type { App } from 'aws-cdk-lib';

export const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
export type EnvName = (typeof ENVIRONMENTS)[number];

export interface EnvConfig {
  readonly name: EnvName;
  /** Aurora Serverless v2 capacity range (context §10). */
  readonly auroraMinAcu: number;
  readonly auroraMaxAcu: number;
  /** Cold starts inside an MCP tool call are unacceptable in prod (T2.1). */
  readonly mcpProvisionedConcurrency: number;
  readonly razorpayLiveMode: boolean;
}

const CONFIGS: Record<EnvName, EnvConfig> = {
  dev: {
    name: 'dev',
    auroraMinAcu: 0.5,
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
  const config = CONFIGS[raw as EnvName];
  if (!config) {
    throw new Error(`Unknown env "${raw}". Pass one of: ${ENVIRONMENTS.join(', ')}`);
  }
  return config;
}

/** Stack names are env-suffixed so all three can coexist in one account. */
export function stackName(base: string, env: EnvConfig): string {
  return `CatalogRail-${base}-${env.name}`;
}
