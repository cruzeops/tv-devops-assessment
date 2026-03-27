# Project Assessment — tv-devops-assessment

Date: 2026-03-27

## 1. Purpose

This document summarizes all actions taken to: (1) containerize an Express + TypeScript application for local use, and (2) scaffold and implement CDK for Terraform (TypeScript) infrastructure to run the container in AWS Fargate behind an internet-facing Application Load Balancer.

## 2. High-level outcome
- Part 1 (containerization): completed and validated locally. The app responds at `http://localhost:3000/health`.
- Part 2 (IaC): CDKTF TypeScript project created under `iac/` and `iac/lib/infra-stack.ts` implements AWS resources (ECR, VPC, subnets, IGW, route table, security groups, IAM task execution role, CloudWatch log group, ECS cluster, Fargate task definition & service, ALB, target group, listener). Deployment requires pushing the container image to ECR and running `cdktf deploy` with AWS credentials.

## 3. Files added or modified

- `src/routes/index.ts` — added GET `/health` endpoint returning HTTP 200 JSON `{ status: 'ok' }`.
- `package.json` — added `build` and `start` scripts to support production builds.
- `Dockerfile` — multi-stage production Dockerfile: build stage compiles TypeScript, final stage copies `dist/` and installs production dependencies; runs `node dist/server.js` and exposes port 3000.
- `docker-compose.yml` — local testing configuration mapping host `3000:3000`.
- `.dockerignore` — excludes `node_modules`, `dist`, `.env`, and other unnecessary files from Docker build context.
- `README.md` — added a short deploy snippet with commands to build/push the image to ECR and run CDKTF synth/deploy.

CDKTF (under `iac/`):
- `iac/main.ts` — CDKTF entrypoint instantiating the stack.
- `iac/package.json` — CDKTF + provider deps and npm scripts (`synth`, `deploy`).
- `iac/cdktf.json` — CDKTF config.
- `iac/tsconfig.json` — TypeScript config for the CDKTF project.
- `iac/lib/infra-stack.ts` — *primary infra implementation* (see infra section below).

New file created by this assessment:
- `project-assessment.md` (this file).

## 4. Commands executed locally (verification)
- `npm install` — install project dependencies (noted some npm audit warnings).
- `npm run build` — compiled TypeScript into `dist/`.
- `node dist/server.js` — started server; validated it served HTTP 200 on `/health`.
- `curl http://localhost:3000/health` — returned `200`.

No AWS CLI or CDKTF `deploy` commands were executed by me in your account (these require AWS credentials and a pushed image).

## 5. CDKTF infra: design and implementation details

Primary resources implemented in `iac/lib/infra-stack.ts`:

- ECR repository: created for `APP_NAME` (name parameterizable).
- VPC: single VPC `10.0.0.0/16` with two public subnets (e.g., `10.0.1.0/24`, `10.0.2.0/24`) across AZs.
- Internet Gateway and public route table with default route to IGW; route table associations for public subnets.
- Security Groups:
  - `albSg`: allows ingress on port 80 (0.0.0.0/0) for ALB.
  - `ecsSg`: allows ingress from `albSg` on port 3000 for ECS tasks.
- IAM: `ecsExecutionRole` for ECS task execution with `AmazonECSTaskExecutionRolePolicy` attached (standard managed policy). The role has trust for `ecs-tasks.amazonaws.com`.
- CloudWatch Log Group: `/ecs/<appName>` with retention days set.
- ECS: Cluster created; Fargate task definition with container referencing `IMAGE_URI` environment variable (or repository URL if provided), CPU/memory tuned (256/512), and awslogs logging driver configured.
- ECS Service: Fargate service with `network_configuration` using public subnets and `assignPublicIp = true`, attached to the ALB target group.
- ALB: internet-facing ALB in public subnets; target group uses port 3000 with health check path `/health` and 200 matcher; listener on port 80 forwards to TG.
- Outputs: ALB DNS (`alb.dnsName`) and `healthUrl` (`http://<alb-dns>/health`) are emitted as Terraform outputs for verification.

Notes on parameterization:
- The stack reads `AWS_REGION`/`AWS_DEFAULT_REGION` for provider region.
- `APP_NAME` and `IMAGE_URI` are expected as environment variables or inputs prior to deploy; `IMAGE_URI` must reference an image pushed to ECR.

## 6. How to deploy (concise step-by-step)

1) Build & push Docker image to ECR (from repo root):

```bash
export AWS_REGION=us-east-1
export APP_NAME=my-express-app

docker build -t ${APP_NAME}:latest ./app
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI=${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${APP_NAME}

aws ecr describe-repositories --repository-names "${APP_NAME}" --region ${AWS_REGION} || \
  aws ecr create-repository --repository-name "${APP_NAME}" --region ${AWS_REGION}

aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
docker tag ${APP_NAME}:latest ${ECR_URI}:latest
docker push ${ECR_URI}:latest

# Then set
export IMAGE_URI=${ECR_URI}:latest
```

2) Deploy infra with CDKTF (from `iac/`):

```bash
cd iac
npm install
npm run synth
npm run deploy -- --auto-approve
# or: cdktf deploy --auto-approve
```

After successful deploy, get the `healthUrl` output and visit `http://<alb-dns>/health`.

## 7. Assumptions and constraints
- No AWS credentials were used by me; you must supply credentials locally (env vars or AWS profile) to push to ECR and run `cdktf deploy`.
- The ECS service depends on a valid `IMAGE_URI` pointing to ECR; if not set or image not present, ECS will fail to start tasks.
- IAM permissions for the principal running `cdktf deploy` must allow creation of VPC, ECS, IAM roles, ECR, ALB, CloudWatch, and related resources.

## 8. Security and production considerations
- Review and tighten IAM policies beyond the default `AmazonECSTaskExecutionRolePolicy` if your security posture requires least privilege.
- Consider private subnets + NAT + internal-only ECS tasks for backend services; use public subnets only when tasks must have public IPs.
- Enable health checks and logging retention policies appropriate for compliance; CloudWatch Logs retention was set but can be adjusted.
- Add secrets management (AWS Secrets Manager or Parameter Store) for any credentials; avoid embedding secrets in task definitions.

## 9. Pending tasks / recommended improvements
- Push Docker image to ECR and run `cdktf deploy` (required to run app in AWS).
- Add CI pipeline (GitHub Actions) to automate build → tag → push → cdktf deploy.
- Add autoscaling for ECS service, deploy in private subnets with NAT Gateway, add HTTPS listener with ACM certificate for production.
- Split `iac/lib/infra-stack.ts` into smaller modules for maintainability.

## 10. Audit checklist (what I verified)
- Application builds (`tsc`) and server runs locally.
- `/health` endpoint returns HTTP 200 locally.
- Dockerfile and docker-compose were added for local container testing.
- CDKTF project syntactically scaffolded and infra code implemented (no live resources created by me).

---

If you want, I can now generate a CI pipeline (GitHub Actions) to automate build→push→deploy, or proceed to run the push + `cdktf deploy` for you (I will need AWS credentials or a profile name). Requested next action: [CI pipeline | Run push+deploy | Nothing].
