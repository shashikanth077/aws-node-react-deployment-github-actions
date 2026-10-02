# 05 — Docker image + ECR

```
 Developer ─► docker build ─► Docker image ─► docker push ─► ECR repository ─► ECS pulls it ─► Fargate task
   (laptop)    (Dockerfile)    product-api:1.0.0                product-api       (execution role)
```

## What the Dockerfile does

[`backend/Dockerfile`](../backend/Dockerfile), line by line:

| Instruction | What and why |
|-------------|--------------|
| `FROM node:22-alpine AS deps` | Stage 1 on a tiny Alpine base (~50 MB vs ~400 MB for Debian) |
| `COPY package*.json` then `npm ci --omit=dev` | Installs **exact** locked, production-only dependencies. Copying the manifests *before* the source means Docker caches this layer until dependencies change → fast rebuilds |
| `FROM node:22-alpine` (stage 2) | Fresh runtime image: build tooling and npm cache of stage 1 are not shipped |
| `ENV NODE_ENV=production` | Express and libraries switch to production behaviour |
| `ADD https://truststore.pki.rds.amazonaws.com/...pem` | Amazon's RDS CA bundle so `DB_SSL=true` can **verify** the database's certificate |
| `COPY --from=deps node_modules`, `src`, `db` | Only what runtime needs (`db/*.sql` for the one-off init task) |
| `RUN chown …` + `USER node` | Run as a non-root user: a compromised app cannot modify the container's system files |
| `EXPOSE 3000` | Documentation only; the real port mapping is in the ECS task definition |
| `HEALTHCHECK` | Used by plain Docker/compose. **ECS ignores it** — ECS and the ALB use their own health checks |
| `CMD ["node","src/server.js"]` | Exec form (no shell) so Node is PID 1 and receives `SIGTERM` on deployments → graceful shutdown |

[`backend/.dockerignore`](../backend/.dockerignore) keeps `node_modules`, `.env` and friends **out of the build context**
(so secrets and your Windows-built modules never enter the image).

## 1. Build locally

```bash
cd backend
docker build -t product-api:1.0.0 .
docker images product-api
```
```
REPOSITORY    TAG     IMAGE ID       CREATED          SIZE
product-api   1.0.0   3f2a1b9c4d5e   10 seconds ago   (size varies, roughly 150-200MB)
```

> **CPU architecture.** Fargate defaults to **x86_64**. A Windows/Intel PC builds x86_64 images natively. On an Apple Silicon Mac
> build with `docker build --platform linux/amd64 …` (or set `cpuArchitecture: ARM64` in the task definition). Mismatch → tasks die with `exec format error`.

## 2. Test locally

You need a MySQL. Reuse the compose database from chapter 01:

```bash
docker compose up -d db
docker run --rm -p 3000:3000 --network aws-node-react-deployment-github-actions_default \
  -e DB_HOST=db -e DB_NAME=productsdb -e DB_USER=root -e DB_PASSWORD=localdevpassword \
  product-api:1.0.0
```
(The network name is `<folder-name>_default`; run `docker network ls` if yours differs.)

In another terminal:

```bash
curl -s localhost:3000/health            # {"status":"ok"}
curl -s localhost:3000/api/products      # the 5 products (run `docker compose run --rm api npm run db:init` first if empty)
docker exec $(docker ps -qf ancestor=product-api:1.0.0) whoami    # node   (not root)
```

## 3. Create the ECR repository

**What it is.** ECR is a private Docker registry (like Docker Hub, but inside your account and IAM-controlled).
**Why we need it.** ECS Fargate has no access to your laptop; it must pull the image from a registry it can reach with IAM permissions.

```bash
aws ecr create-repository --repository-name product-api \
  --image-scanning-configuration scanOnPush=true --region $AWS_REGION
aws ecr put-lifecycle-policy --repository-name product-api \
  --lifecycle-policy-text file://infra/ecr-lifecycle-policy.json
```

The lifecycle policy keeps only the last 5 images so storage stays inside the free 500 MB.

```bash
export ECR_URI=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/product-api
echo $ECR_URI      # 123456789012.dkr.ecr.eu-central-1.amazonaws.com/product-api
```

## 4. Tag, authenticate, push

```bash
# Tag: give the local image the full registry name
docker tag product-api:1.0.0 $ECR_URI:1.0.0

# Authenticate: get a 12-hour password from AWS and hand it to Docker
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
# → Login Succeeded

# Push
docker push $ECR_URI:1.0.0
```
```
The push refers to repository [123456789012.dkr.ecr.eu-central-1.amazonaws.com/product-api]
5f70bf18a086: Pushed
...
1.0.0: digest: sha256:9d3c… size: 1573
```

A tag is just a label. **Use unique, meaningful tags (`1.0.0`, a git SHA) — not `latest`** — so every task definition
revision points to exactly one immutable build and you can roll back by pointing at an older tag.

## How traffic (the image) flows

```
 your PC ──docker push (HTTPS, IAM-auth)──► ECR (regional, private)
 Fargate task launch:  ECS agent (execution role) ──► ECR GetAuthorizationToken + pull
      path from a private subnet:  manifest/API via NAT Gateway · layers from S3 via the S3 gateway endpoint
```

## Verify

```bash
aws ecr describe-images --repository-name product-api \
  --query 'imageDetails[].[imageTags[0],imagePushedAt,imageSizeInBytes]' --output table
```
```
-----------------------------------------------------------
|                      DescribeImages                     |
+-------+---------------------------------+---------------+
|  1.0.0|  2026-10-02T12:34:56.000000+03:00|  58123456    |
+-------+---------------------------------+---------------+
```
Console → **ECR → Repositories → product-api** shows the image, and (after a minute) the scan findings.

## Common mistakes

- **`no basic auth credentials` / `denied`** — login expired (12 h) or you logged into a different region/account. Re-run the `docker login`.
- **`repository does not exist`** — wrong region, or you pushed a tag without the `<account>.dkr.ecr...` prefix (it then goes to Docker Hub).
- **Pushing `latest` and expecting ECS to notice** — ECS only re-pulls when a task starts. Prefer new tags + new task definition revisions.
- **Image built on Apple Silicon** (see the architecture note).
- **Committing `.env` into the image** — `.dockerignore` prevents it; do not remove it.

## Troubleshoot

| Symptom | Fix |
|---------|-----|
| ECS task: `CannotPullContainerError: pull image manifest has been retried` | Private subnets can't reach ECR → NAT route (chapter 02); or wrong image URI/tag |
| ECS task: `not authorized to perform: ecr:GetAuthorizationToken` | Execution role lacks `AmazonECSTaskExecutionRolePolicy` |
| Task starts then stops with `exec format error` | CPU architecture mismatch |
| `docker build` very slow on Windows | Build from WSL2 filesystem, make sure `node_modules` is in `.dockerignore` |
