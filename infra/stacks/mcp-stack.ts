import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../lib/env.js';
import { createFunction } from '../lib/lambda.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

export interface McpStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly apiBaseUrl: string;
  readonly buyerAppUrl: string;
  readonly vpc?: ec2.IVpc;
}

/**
 * T2.1 — the MCP server, behind a Function URL.
 *
 * A Function URL rather than API Gateway. The MCP transport is a single POST endpoint with
 * no routing, no authorizer of ours (Claude and ChatGPT handle their own auth), and no CORS
 * story worth managing — so a gateway in front would add a hop, a cold start and a second
 * place for the CORS misconfiguration that cost this project a week in Phase 1.
 *
 * **Not in the VPC**, deliberately. It talks only to the HTTP API over the public internet
 * and never to Aurora, so putting it in private subnets would add ENI attachment to every
 * cold start for no reachability it needs — and cold starts inside a tool call are the one
 * latency this service cannot hide.
 */
export class McpStack extends Stack {
  readonly functionUrl: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: McpStackProps) {
    super(scope, id, props);

    const { config } = props;

    const mcp = createFunction(this, 'McpServer', {
      config,
      entry: path.join(REPO_ROOT, 'services/mcp/src/handler.ts'),
      timeout: Duration.seconds(29),
      // Holds a query vector and a page of results; CPU scales with memory on Lambda, and
      // T2.28 budgets p95 under 1.5s for a whole tool call.
      memorySize: 1024,
      environment: {
        API_BASE_URL: props.apiBaseUrl,
        BUYER_APP_URL: props.buyerAppUrl,
      },
    });

    /**
     * Signs its own calls to `/internal/*`, which is IAM-authorized.
     *
     * Scoped to this account's APIs rather than `*`: the MCP server is the most exposed
     * thing here — anyone can reach the Function URL — so its credentials should reach as
     * little as possible if the function is ever compromised.
     */
    mcp.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*/POST/internal/*`],
      }),
    );

    /**
     * Provisioned concurrency in production only.
     *
     * A cold start inside a tool call is a model waiting mid-sentence, which reads to the
     * buyer as the assistant having stalled. In dev it is a cost with no audience.
     */
    if (config.mcpProvisionedConcurrency > 0) {
      const alias = new lambda.Alias(this, 'McpLive', {
        aliasName: 'live',
        version: mcp.currentVersion,
        provisionedConcurrentExecutions: config.mcpProvisionedConcurrency,
      });
      this.functionUrl = alias.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    } else {
      this.functionUrl = mcp.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    }

    new CfnOutput(this, 'McpUrl', {
      value: this.functionUrl.url,
      description: 'MCP endpoint to add as a connector in Claude or ChatGPT',
    });
  }
}
