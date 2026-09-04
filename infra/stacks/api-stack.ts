import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../lib/env.js';
import { createFunction, databaseEnvironment } from '../lib/lambda.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

export interface ApiStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly vpc: ec2.IVpc;
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  readonly proxy: rds.DatabaseProxy;
  readonly uploadsBucket: s3.IBucket;
  /** DynamoDB tables the search path uses (T1.19, T1.20). */
  readonly queryCacheTable: dynamodb.ITable;
  readonly searchLogsTable: dynamodb.ITable;
}

/**
 * The merchant HTTP API.
 *
 * Every route is behind IAM authorization, and that is not a placeholder to tidy up later —
 * it is what makes the stack safe to deploy before T1.6 exists. `POST /merchant/uploads`
 * hands back a presigned URL scoped to a merchant's own S3 prefix, so an unauthenticated
 * version of it would let anyone write into anyone's catalogue. IAM auth means only a
 * SigV4-signed request from a principal in this account gets through, which is the right
 * gate for a development deployment and is replaced, not merely relaxed, when the Razorpay
 * OAuth session lands.
 */
export class ApiStack extends Stack {
  readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { config, vpc, lambdaSecurityGroup, proxy } = props;

    const merchantApi = createFunction(this, 'MerchantApi', {
      config,
      entry: path.join(REPO_ROOT, 'services/api-merchant/src/handler.ts'),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.seconds(29), // API Gateway gives up at 30.
      environment: {
        ...databaseEnvironment(proxy.endpoint),
        S3_BUCKET_UPLOADS: props.uploadsBucket.bucketName,
      },
    });

    proxy.grantConnect(merchantApi, 'catalograil');
    // Presigning a PUT requires the permission the URL will carry.
    props.uploadsBucket.grantPut(merchantApi);

    this.api = new apigw.HttpApi(this, 'MerchantHttpApi', {
      apiName: `${config.resourcePrefix}-${config.name}-merchant`,
      description: 'Merchant-facing API',
      corsPreflight: {
        allowOrigins: config.name === 'prod' ? ['https://merchant.catalograil.com'] : ['*'],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
        ],
        allowHeaders: ['content-type', 'authorization', 'x-merchant-id'],
        maxAge: Duration.hours(1),
      },
    });

    /**
     * The internal search API (T1.19).
     *
     * A separate function from the merchant API, not because the code demands it but
     * because their shapes differ: search is latency-critical with a 200ms budget and
     * needs Bedrock, while the merchant API is a CRUD surface. Sharing one function would
     * mean the merchant API's cold starts and memory footprint set search's floor.
     */
    const internalApi = createFunction(this, 'InternalApi', {
      config,
      entry: path.join(REPO_ROOT, 'services/api-internal/src/handler.ts'),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.seconds(29),
      // Larger than the merchant API: a search holds a 1024-float query vector and hydrates
      // a page of results, and CPU scales with memory on Lambda.
      memorySize: 2048,
      environment: {
        ...databaseEnvironment(proxy.endpoint),
        DDB_TABLE_QUERY_CACHE: props.queryCacheTable.tableName,
        DDB_TABLE_SEARCH_LOGS: props.searchLogsTable.tableName,
        BEDROCK_REGION: this.region,
        BEDROCK_TEXT_EMBED_MODEL_ID: 'global.cohere.embed-v4:0',
        BEDROCK_IMAGE_EMBED_MODEL_ID: 'global.cohere.embed-v4:0',
      },
    });

    proxy.grantConnect(internalApi, 'catalograil');
    props.queryCacheTable.grantReadWriteData(internalApi);
    props.searchLogsTable.grantWriteData(internalApi);
    internalApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        // Embed v4 is reached through a global inference profile, which may route to any
        // region, so the resource cannot be pinned to this one.
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          'arn:aws:bedrock:*:*:inference-profile/*',
        ],
      }),
    );

    const integration = new HttpLambdaIntegration('MerchantIntegration', merchantApi);

    this.api.addRoutes({
      path: '/merchant/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration,
      authorizer: new HttpIamAuthorizer(),
    });

    this.api.addRoutes({
      path: '/internal/{proxy+}',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('InternalIntegration', internalApi),
      // Same gate as the merchant routes: search is not public, and the MCP server will
      // sign its calls the same way the dashboard does.
      authorizer: new HttpIamAuthorizer(),
    });

    new CfnOutput(this, 'MerchantApiUrl', {
      value: this.api.apiEndpoint,
      description: 'Merchant API base URL (requests must be SigV4 signed)',
    });
  }
}
