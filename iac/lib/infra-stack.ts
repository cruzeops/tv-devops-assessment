import { Construct } from 'constructs';
import { TerraformStack } from 'cdktf';
import { AwsProvider } from '@cdktf/provider-aws';
import { EcrRepository } from '@cdktf/provider-aws/lib/ecr';
import { Vpc, Subnet, InternetGateway, RouteTable, Route, RouteTableAssociation } from '@cdktf/provider-aws/lib/vpc';
import { SecurityGroup } from '@cdktf/provider-aws/lib/ec2';
import { IamRole, IamRolePolicyAttachment } from '@cdktf/provider-aws/lib/iam';
import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch';
import { EcsCluster, EcsTaskDefinition, EcsService } from '@cdktf/provider-aws/lib/ecs';
import { Alb, AlbTargetGroup, AlbListener } from '@cdktf/provider-aws/lib/lb';
import { TerraformOutput } from 'cdktf';

export class InfraStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Region comes from environment or falls back to us-east-1
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

    new AwsProvider(this, 'aws', {
      region,
    });

    // Basic configuration values (parameterize via env vars)
    const appName = process.env.APP_NAME || 'express-ts-app';
    const imageUri = process.env.IMAGE_URI || '';

    // 1) ECR repository
    const repo = new EcrRepository(this, 'app-ecr', {
      name: appName,
      imageTagMutability: 'MUTABLE',
    });

    // 2) VPC + public subnets + IGW + route table
    const vpc = new Vpc(this, 'app-vpc', {
      cidrBlock: '10.0.0.0/16',
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: { Name: `${appName}-vpc` },
    });

    const publicSubnet1 = new Subnet(this, 'pub-subnet-1', {
      vpcId: vpc.id,
      cidrBlock: '10.0.1.0/24',
      availabilityZone: `${region}a`,
      mapPublicIpOnLaunch: true,
      tags: { Name: `${appName}-pub-1` },
    });

    const publicSubnet2 = new Subnet(this, 'pub-subnet-2', {
      vpcId: vpc.id,
      cidrBlock: '10.0.2.0/24',
      availabilityZone: `${region}b`,
      mapPublicIpOnLaunch: true,
      tags: { Name: `${appName}-pub-2` },
    });

    const igw = new InternetGateway(this, 'igw', {
      vpcId: vpc.id,
      tags: { Name: `${appName}-igw` },
    });

    const publicRt = new RouteTable(this, 'public-rt', {
      vpcId: vpc.id,
      route: [{ cidrBlock: '0.0.0.0/0', gatewayId: igw.id }],
      tags: { Name: `${appName}-public-rt` },
    });

    new RouteTableAssociation(this, 'rta-1', {
      subnetId: publicSubnet1.id,
      routeTableId: publicRt.id,
    });

    new RouteTableAssociation(this, 'rta-2', {
      subnetId: publicSubnet2.id,
      routeTableId: publicRt.id,
    });

    // 3) Security groups
    const albSg = new SecurityGroup(this, 'alb-sg', {
      name: `${appName}-alb-sg`,
      description: 'Allow HTTP to ALB',
      vpcId: vpc.id,
      ingress: [{ fromPort: 80, toPort: 80, protocol: 'tcp', cidrBlocks: ['0.0.0.0/0'] }],
      egress: [{ fromPort: 0, toPort: 0, protocol: '-1', cidrBlocks: ['0.0.0.0/0'] }],
    });

    const ecsSg = new SecurityGroup(this, 'ecs-sg', {
      name: `${appName}-ecs-sg`,
      description: 'Allow traffic from ALB to ECS tasks',
      vpcId: vpc.id,
      ingress: [{ fromPort: 3000, toPort: 3000, protocol: 'tcp', securityGroups: [albSg.id] }],
      egress: [{ fromPort: 0, toPort: 0, protocol: '-1', cidrBlocks: ['0.0.0.0/0'] }],
    });

    // 4) IAM role for ECS task execution
    const ecsExecutionRole = new IamRole(this, 'ecs-exec-role', {
      name: `${appName}-ecs-exec-role`,
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      }),
    });

    new IamRolePolicyAttachment(this, 'ecs-exec-policy-attach', {
      role: ecsExecutionRole.name,
      policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    });

    // 5) CloudWatch log group
    const logGroup = new CloudwatchLogGroup(this, 'app-log-group', {
      name: `/ecs/${appName}`,
      retentionInDays: 7,
    });

    // 6) ECS cluster
    const cluster = new EcsCluster(this, 'ecs-cluster', {
      name: `${appName}-cluster`,
    });

    // 7) Task definition (Fargate) — container definitions reference IMAGE_URI env var
    const containerDef = JSON.stringify([
      {
        name: appName,
        image: imageUri || repo.repositoryUrl /* allow using repo URL when IMAGE_URI not provided */,
        essential: true,
        portMappings: [{ containerPort: 3000, protocol: 'tcp' }],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': logGroup.name,
            'awslogs-region': region,
            'awslogs-stream-prefix': appName,
          },
        },
      },
    ]);

    const taskDef = new EcsTaskDefinition(this, 'task-def', {
      family: `${appName}-task`,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: '256',
      memory: '512',
      executionRoleArn: ecsExecutionRole.arn,
      containerDefinitions: containerDef,
    });

    // 8) ALB
    const alb = new Alb(this, 'app-alb', {
      name: `${appName}-alb`,
      internal: false,
      securityGroups: [albSg.id],
      subnets: [publicSubnet1.id, publicSubnet2.id],
    });

    const targetGroup = new AlbTargetGroup(this, 'tg', {
      name: `${appName}-tg`,
      port: 3000,
      protocol: 'HTTP',
      targetType: 'ip',
      vpcId: vpc.id,
      healthCheck: { path: '/health', matcher: '200', interval: 30 },
    });

    new AlbListener(this, 'listener', {
      loadBalancerArn: alb.arn,
      port: 80,
      protocol: 'HTTP',
      defaultAction: [{ type: 'forward', targetGroupArn: targetGroup.arn }],
    });

    // 9) ECS service
    const service = new EcsService(this, 'ecs-service', {
      name: `${appName}-service`,
      cluster: cluster.id,
      taskDefinition: taskDef.arn,
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: {
        assignPublicIp: true,
        subnets: [publicSubnet1.id, publicSubnet2.id],
        securityGroups: [ecsSg.id],
      },
      loadBalancer: [
        {
          targetGroupArn: targetGroup.arn,
          containerName: appName,
          containerPort: 3000,
        },
      ],
    });

    // 10) Outputs: ALB DNS and health URL
    new TerraformOutput(this, 'albDns', {
      value: alb.dnsName,
      description: 'Application Load Balancer DNS name',
    });

    new TerraformOutput(this, 'healthUrl', {
      value: `http://${alb.dnsName}/health`,
      description: 'Health check URL for the app',
    });

    // Note: Before deploy, set IMAGE_URI env var to a pushed ECR image (e.g. <account>.dkr.ecr.<region>.amazonaws.com/<repo>:tag)
  }
}
