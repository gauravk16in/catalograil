import { Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../lib/env.js';

export interface NetworkStackProps extends StackProps {
  readonly config: EnvConfig;
}

/**
 * The VPC everything else sits in.
 *
 * Holds the VPC and the Lambda security group only. The database and proxy groups live in
 * the data stack beside the cluster they guard: CDK's proxy wiring adds an ingress rule
 * referencing the cluster's port, and a group owned here would make that a cross-stack
 * reference back from Data to Network — a cycle, since Data already depends on the subnets.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  /** Lambdas. Has egress, because Bedrock, the Anthropic API and Razorpay are all external. */
  readonly lambdaSecurityGroup: ec2.SecurityGroup;

  /**
   * Declared rather than looked up.
   *
   * The default implementation calls `ec2:DescribeAvailabilityZones`, which makes `cdk
   * synth` require credentials and produce different output depending on whose they are.
   * The region is fixed by D8, so naming the zones keeps synthesis hermetic — it runs in
   * CI, in a pull request, and on a laptop with no AWS access, and produces byte-identical
   * templates every time.
   */
  override get availabilityZones(): string[] {
    return ['ap-south-1a', 'ap-south-1b', 'ap-south-1c'];
  }

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      // One NAT outside production. A NAT gateway is billed hourly whether or not it
      // carries traffic, and a dev environment does not need the second one's redundancy.
      natGateways: config.name === 'prod' ? 2 : 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // Gateway endpoints are free and keep S3 and DynamoDB traffic off the NAT, which is
      // most of what ingestion and the caches do.
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        DynamoDb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: this.vpc,
      description: 'Lambda functions',
      allowAllOutbound: true,
    });
  }
}
