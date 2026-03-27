# Infrastructure (CDK for Terraform) — tv-devops-assessment

This folder contains the CDK for Terraform (TypeScript) project to provision AWS infrastructure for the containerized app.

Quick start

1. Install dependencies in `/iac`:

```bash
cd iac
npm install
```

2. Set AWS credentials and region (do NOT hardcode in code):

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
```

3. Synthesize Terraform and deploy:

```bash
npm run synth      # generates Terraform JSON
npm run deploy     # runs `cdktf deploy` (auto-approve)
```

Notes
- This initial scaffold adds provider configuration and a stack class.
- Next steps: implement resources (ECR, VPC, ECS Fargate, ALB, IAM, CloudWatch logs) inside `lib/infra-stack.ts`.
- Use environment variables and `cdktf` inputs for reusable configuration across accounts.
