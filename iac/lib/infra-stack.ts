import { Construct } from "constructs";
import { TerraformStack, TerraformOutput } from "cdktf";
import { AwsProvider, ecr, vpc, iam, ecs, cloudwatch, lb } from "@cdktf/provider-aws";

export class InfraStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const region =
      process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

    const appName = process.env.APP_NAME || "express-ts-app";
    const imageUri = process.env.IMAGE_URI || "";

    new AwsProvider(this, "aws", {
      region,
    });

    // 1) ECR repository
    const repo = new ecr.EcrRepository(this, "app-ecr", {
      name: appName,
      imageTagMutability: "MUTABLE",
      imageScanningConfiguration: {
        scanOnPush: true,
      },
    });

    // 2) VPC + public subnets + IGW + route table
    const appVpc = new vpc.Vpc(this, "app-vpc", {
      cidrBlock: "10.0.0.0/16",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: { Name: `${appName}-vpc` },
    });

    const publicSubnet1 = new vpc.Subnet(this, "pub-subnet-1", {
      vpcId: appVpc.id,
      cidrBlock: "10.0.1.0/24",
      availabilityZone: `${region}a`,
      mapPublicIpOnLaunch: true,
      tags: { Name: `${appName}-pub-1` },
    });

    const publicSubnet2 = new vpc.Subnet(this, "pub-subnet-2", {
      vpcId: appVpc.id,
      cidrBlock: "10.0.2.0/24",
      availabilityZone: `${region}b`,
      mapPublicIpOnLaunch: true,
      tags: { Name: `${appName}-pub-2` },
    });

    const igw = new vpc.InternetGateway(this, "igw", {
      vpcId: appVpc.id,
      tags: { Name: `${appName}-igw` },
    });

    const publicRt = new vpc.RouteTable(this, "public-rt", {
      vpcId: appVpc.id,
      route: [
        {
          cidrBlock: "0.0.0.0/0",
          gatewayId: igw.id,
        },
      ],
      tags: { Name: `${appName}-public-rt` },
    });

    new vpc.RouteTableAssociation(this, "rta-1", {
      subnetId: publicSubnet1.id,
      routeTableId: publicRt.id,
    });

    new vpc.RouteTableAssociation(this, "rta-2", {
      subnetId: publicSubnet2.id,
      routeTableId: publicRt.id,
    });

    // 3) Security groups
    const albSg = new vpc.SecurityGroup(this, "alb-sg", {
      name: `${appName}-alb-sg`,
      description: "Allow HTTP to ALB",
      vpcId: appVpc.id,
      ingress: [
        {
          fromPort: 80,
          toPort: 80,
          protocol: "tcp",
          cidrBlocks: ["0.0.0.0/0"],
        },
      ],
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
        },
      ],
      tags: { Name: `${appName}-alb-sg` },
    });

    const ecsSg = new vpc.SecurityGroup(this, "ecs-sg", {
      name: `${appName}-ecs-sg`,
      description: "Allow traffic from ALB to ECS tasks",
      vpcId: appVpc.id,
      ingress: [
        {
          fromPort: 3000,
          toPort: 3000,
          protocol: "tcp",
          securityGroups: [albSg.id],
        },
      ],
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
        },
      ],
      tags: { Name: `${appName}-ecs-sg` },
    });

    // 4) IAM roles
    const ecsExecutionRole = new iam.IamRole(this, "ecs-exec-role", {
      name: `${appName}-ecs-exec-role`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    new iam.IamRolePolicyAttachment(this, "ecs-exec-policy-attach", {
      role: ecsExecutionRole.name,
      policyArn:
        "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    });

    const ecsTaskRole = new iam.IamRole(this, "ecs-task-role", {
      name: `${appName}-ecs-task-role`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    // 5) CloudWatch log group
    const logGroup = new cloudwatch.CloudwatchLogGroup(this, "app-log-group", {
      name: `/ecs/${appName}`,
      retentionInDays: 7,
    });

    // 6) ECS cluster
    const cluster = new ecs.EcsCluster(this, "ecs-cluster", {
      name: `${appName}-cluster`,
    });

    // 7) Task definition
    const containerDef = JSON.stringify([
      {
        name: appName,
        image: imageUri || `${repo.repositoryUrl}:latest`,
        essential: true,
        portMappings: [
          {
            containerPort: 3000,
            hostPort: 3000,
            protocol: "tcp",
          },
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": logGroup.name,
            "awslogs-region": region,
            "awslogs-stream-prefix": appName,
          },
        },
      },
    ]);

    const taskDef = new ecs.EcsTaskDefinition(this, "task-def", {
      family: `${appName}-task`,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "256",
      memory: "512",
      executionRoleArn: ecsExecutionRole.arn,
      taskRoleArn: ecsTaskRole.arn,
      containerDefinitions: containerDef,
    });

    // 8) Application Load Balancer
    const applicationLb = new lb.Lb(this, "app-alb", {
      name: `${appName}-alb`,
      internal: false,
      loadBalancerType: "application",
      securityGroups: [albSg.id],
      subnets: [publicSubnet1.id, publicSubnet2.id],
    });

    const targetGroup = new lb.LbTargetGroup(this, "tg", {
      name: `${appName}-tg`,
      port: 3000,
      protocol: "HTTP",
      targetType: "ip",
      vpcId: appVpc.id,
      healthCheck: {
        path: "/health",
        matcher: "200",
        interval: 30,
      },
    });

    new lb.LbListener(this, "listener", {
      loadBalancerArn: applicationLb.arn,
      port: 80,
      protocol: "HTTP",
      defaultAction: [
        {
          type: "forward",
          targetGroupArn: targetGroup.arn,
        },
      ],
    });

    // 9) ECS service
    new ecs.EcsService(this, "ecs-service", {
      name: `${appName}-service`,
      cluster: cluster.id,
      taskDefinition: taskDef.arn,
      desiredCount: 1,
      launchType: "FARGATE",
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
      dependsOn: [applicationLb, targetGroup],
    });

    // 10) Outputs
    new TerraformOutput(this, "ecrRepositoryUrl", {
      value: repo.repositoryUrl,
      description: "ECR repository URL",
    });

    new TerraformOutput(this, "albDns", {
      value: applicationLb.dnsName,
      description: "Application Load Balancer DNS name",
    });

    new TerraformOutput(this, "healthUrl", {
      value: `http://${applicationLb.dnsName}/health`,
      description: "Health check URL for the app",
    });
  }
}