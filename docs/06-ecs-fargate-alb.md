# 06 — ECS Fargate + Application Load Balancer

Prerequisites: chapters 02 (network), 03 (RDS + IAM roles), 05 (image in ECR). Have these variables set:
`AWS_REGION ACCOUNT_ID VPC_ID PUB_A PUB_B PRIV_A PRIV_B ALB_SG ECS_SG ECR_URI DB_HOST DB_SECRET_ARN`.

## The ECS vocabulary in one picture

```
 Cluster  product-cluster           (a logical group; with Fargate there are no servers to manage)
   └─ Service  product-api-service  ("keep 2 copies of this task running, behind this load balancer, forever")
        └─ Task  (one running copy)  = one or more containers + networking, created from…
             └─ Task Definition  product-api:N   (the blueprint: image, CPU/RAM, port, env, roles, logs)
                  └─ Container  product-api   (our Node image from ECR)
```

**What Fargate is.** You say "run this container with 0.25 vCPU and 512 MB"; AWS finds the compute. You never patch or SSH
into a server. Each task gets its **own network interface (ENI)** with a private IP in your subnet and the security group you choose (`awsvpc` mode) — that is why `ecs-sg` can be so precise.

**Why this app needs it.** Node needs somewhere to run that restarts it when it crashes, replaces it on every deploy, spreads
copies over two AZs and plugs them into a load balancer.

---

## 1. Create the CloudWatch log group (so logs exist from the first second)

```bash
aws logs create-log-group --log-group-name /ecs/product-api
aws logs put-retention-policy --log-group-name /ecs/product-api --retention-in-days 7
```
Retention matters: the default is *never expire* (and you pay to store forever).

## 2. ECS Cluster

Console → **ECS → Clusters → Create cluster** → name `product-cluster`, infrastructure **AWS Fargate (serverless)**.
Leave Container Insights **off** for now (it publishes extra paid metrics; the basic CPU/memory metrics are free).

```bash
aws ecs create-cluster --cluster-name product-cluster          # CLI equivalent
aws ecs describe-clusters --clusters product-cluster --query 'clusters[0].status'     # "ACTIVE"
```
If the CLI later complains about a missing service-linked role: `aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com` (the console does this for you).

## 3. Task definition (the blueprint)

Open [`infra/task-definition.json`](../infra/task-definition.json). Here is what each part means:

| Setting | Value | Explanation |
|---------|-------|-------------|
| `networkMode` | `awsvpc` | required for Fargate; task gets its own ENI + security group |
| `cpu` / `memory` | `256` / `512` | 0.25 vCPU / 0.5 GB — the smallest valid Fargate size. Node + Express idles around 80–120 MB; raise to 512/1024 if you see memory > 70% in CloudWatch. (Fargate only allows specific CPU/memory pairs.) |
| `executionRoleArn` | `productApiTaskExecutionRole` | **ECS agent**: pull from ECR, write logs |
| `taskRoleArn` | `productApiTaskRole` | **your code**: read the DB secret |
| `containerDefinitions[0].image` | `$ECR_URI:1.0.0` | exact tag, never `latest` |
| `portMappings` | `3000` | the port Node listens on; the target group sends traffic here |
| `environment` | `DB_HOST`, `DB_NAME`, `DB_SSL`, `DB_SECRET_ARN`, … | **non-secret** configuration. `DB_SECRET_ARN` is a *pointer* to the secret, not the secret |
| secrets | (none) | credentials are fetched by Node via the task role. The ECS alternative is a `"secrets": [{"name","valueFrom"}]` block — see chapter 03 for the trade-off |
| `healthCheck` | `wget … /health` | container-level check; ECS replaces tasks that fail it |
| `stopTimeout` | `30` | seconds between `SIGTERM` and `SIGKILL`; our server drains requests in that window |
| `linuxParameters.initProcessEnabled` | `true` | tiny init process reaps zombies and forwards signals |
| `logConfiguration` | `awslogs`, group `/ecs/product-api`, prefix `ecs` | **this is what sends `console.log` to CloudWatch** |

Render the placeholders and register a revision:

```bash
export IMAGE_URI=$ECR_URI:1.0.0
bash scripts/render-task-def.sh
aws ecs register-task-definition --cli-input-json file://infra/task-definition.rendered.json \
  --query 'taskDefinition.[family,revision,status]' --output text
# product-api   1   ACTIVE
```
Each change (new image, new env var) = a **new revision**; revisions are immutable, so rollback = "use revision N-1".

## 4. Initialise the database (one-off task)

The DB is private, so we run the **same image** once, overriding the command. This also proves
*image pull → task role → Secrets Manager → RDS* end to end.

```bash
aws ecs run-task --cluster product-cluster --launch-type FARGATE --task-definition product-api \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_A],securityGroups=[$ECS_SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"product-api","command":["node","src/scripts/init-db.js"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

Watch the logs (1–2 minutes: Fargate must provision and pull the image):

```bash
aws logs tail /ecs/product-api --follow --since 5m
```
```
ecs/product-api/3c1f… {"time":"…","level":"info","msg":"db_credentials_loaded","source":"secrets-manager"}
ecs/product-api/3c1f… {"time":"…","level":"info","msg":"db_seeded"}
```
Press Ctrl+C. Re-running it later prints `db_already_seeded` — it is idempotent.

> The task's health check fails (no web server in this run) but the script finishes inside the 20-second `startPeriod`, so ECS ignores it.

## 5. Application Load Balancer + Target Group

**What it is.** The ALB is the single front door: it accepts HTTP(S), picks a healthy task and forwards the request.
**Why this app needs it.** Task IPs change constantly and there are two of them; the ALB gives one stable DNS name,
spreads load across both AZs, and **stops sending traffic to a task that fails its health check**.

**Target group** — EC2 → **Target groups → Create target group**

| Field | Value |
|-------|-------|
| Target type | **IP addresses** (required for Fargate/awsvpc) |
| Name | `product-api-tg` |
| Protocol : Port | HTTP : **3000** |
| VPC | `product-vpc` |
| Health check protocol / path | HTTP / **`/health`** |
| Advanced → healthy / unhealthy threshold | 2 / 3 |
| Timeout / interval | 5 s / 15 s |
| Success codes | 200 |
| **Do not register any targets** | ECS registers/deregisters tasks itself |

After creating: Target group → *Attributes* → **Deregistration delay = 30 seconds** (default 300 s makes every deploy take 5 extra minutes).

**Why `/health` and not `/api/products`?** `/health` only checks "is Node alive". If the health check queried the DB and
MySQL hiccupped, the ALB would mark *both* tasks unhealthy and your site would go fully down. `/health/ready` (DB check) exists for humans.

**Load balancer** — EC2 → **Load balancers → Create → Application Load Balancer**

| Field | Value |
|-------|-------|
| Name | `product-alb` |
| Scheme | **Internet-facing**, IPv4 |
| VPC / subnets | `product-vpc` / `public-a` + `public-b` (**public** subnets, one per AZ) |
| Security group | `alb-sg` only (remove `default`) |
| Listener | HTTP : 80 → forward to `product-api-tg` |

```bash
export ALB_DNS=$(aws elbv2 describe-load-balancers --names product-alb --query 'LoadBalancers[0].DNSName' --output text)
export TG_ARN=$(aws elbv2 describe-target-groups --names product-api-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
echo $ALB_DNS      # product-alb-123456789.eu-central-1.elb.amazonaws.com
```

## 6. ECS Service — 2 tasks, 2 AZs

**What it is.** The service is the supervisor: *"keep `desiredCount` copies running; if one dies, start another; on a new
task definition, roll out gradually."* **Desired count = 2**, with subnets in two AZs, means one task per AZ → if AZ-A burns down, AZ-B keeps serving.

```bash
aws ecs create-service \
  --cluster product-cluster --service-name product-api-service \
  --task-definition product-api --desired-count 2 --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_A,$PRIV_B],securityGroups=[$ECS_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=product-api,containerPort=3000" \
  --health-check-grace-period-seconds 30 \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200"
```

| Option | Why |
|--------|-----|
| subnets = both **private-app** subnets | Fargate spreads tasks across them (AZ balancing) |
| `assignPublicIp=DISABLED` | tasks are unreachable from the internet; outbound goes via NAT |
| `securityGroups=ecs-sg` | only the ALB may connect to port 3000 |
| `minimumHealthyPercent=100`, `maximumPercent=200` | **zero-downtime rolling deploy**: start 2 new tasks first, then stop the 2 old ones |
| `deploymentCircuitBreaker … rollback=true` | if new tasks keep failing to start/become healthy, ECS **automatically rolls back** to the last good revision |
| `health-check-grace-period-seconds` | ignore ALB health failures for 30 s while the container boots |

(Console: ECS → cluster → **Services → Create** with the same values; choose *Application Load Balancer → use an existing load balancer / target group*.)

### What a deployment looks like

```
 before : [Task A (rev 1)]  [Task B (rev 1)]                     ALB → A, B
 step 1 : start [Task C (rev 2)] [Task D (rev 2)]                 ALB → A, B (C, D still booting)
 step 2 : C, D pass health checks → registered                    ALB → A, B, C, D
 step 3 : ALB drains A, B (30 s) → SIGTERM → graceful shutdown    ALB → C, D
 failure: C or D never healthy → circuit breaker → roll back to rev 1
```

To deploy a new version later: build → tag `1.0.1` → push → set `IMAGE_URI` → re-run `render-task-def.sh` → `register-task-definition` →

```bash
aws ecs update-service --cluster product-cluster --service product-api-service --task-definition product-api
# (--force-new-deployment restarts tasks on the *same* revision, e.g. to pick up a changed secret)
```

## Verify

**1. Service state**

```bash
aws ecs describe-services --cluster product-cluster --services product-api-service \
  --query 'services[0].[status,desiredCount,runningCount,deployments[0].rolloutState]' --output text
# ACTIVE   2   2   COMPLETED
```
**2. Tasks are in two AZs**

```bash
aws ecs list-tasks --cluster product-cluster --service-name product-api-service --query 'taskArns' --output text | tr '\t' '\n' | tr -d '\r' \
 | xargs -r -n10 aws ecs describe-tasks --cluster product-cluster --query 'tasks[].[availabilityZone,lastStatus,healthStatus,containers[0].networkInterfaces[0].privateIpv4Address]' --output table --tasks
```
```
----------------------------------------------------
|                  DescribeTasks                   |
+---------------+----------+----------+------------+
|  eu-central-1a|  RUNNING |  HEALTHY |  10.0.2.37 |
|  eu-central-1b|  RUNNING |  HEALTHY |  10.0.4.112|
```
**3. ALB sees both targets healthy**

```bash
aws elbv2 describe-target-health --target-group-arn $TG_ARN \
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output table
# 10.0.2.37  healthy / 10.0.4.112  healthy
```
**4. End to end through the load balancer**

```bash
curl -s http://$ALB_DNS/health
curl -s http://$ALB_DNS/api/products | head -c 300
```
**5. Prove high availability** — kill one task, keep calling the API:

```bash
TASK=$(aws ecs list-tasks --cluster product-cluster --service-name product-api-service --query 'taskArns[0]' --output text)
aws ecs stop-task --cluster product-cluster --task $TASK --reason "HA test"
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code} " http://$ALB_DNS/health; sleep 2; done
# 200 200 200 200 ...   (no failures)  — and ECS starts a replacement within ~1 minute
```

## How traffic flows

```
 client ─► ALB (public-a/public-b, alb-sg:80) ─► picks a HEALTHY target (round robin)
        ─► task private IP :3000 (ecs-sg allows alb-sg)
        ─► Node pool ─► RDS :3306 (rds-sg allows ecs-sg)
 health checker: ALB ─► GET /health every 15 s on every task; 2 passes = in, 3 fails = out
```

## Common mistakes

- **Target type `instance`** instead of `ip` → the service can't register Fargate tasks.
- **Target group port ≠ container port** (80 vs 3000).
- **Tasks in public subnets with no public IP**, or private subnets **without** a NAT route → they can't pull the image.
- **Health-check path wrong / returns 301/404** → tasks cycle: start → unhealthy → killed → start…
- **`ecs-sg` allows port 3000 from `0.0.0.0/0`** or the ALB SG missing → timeouts or a security hole.
- **Node listening on `127.0.0.1`** — must listen on all interfaces (Express' default `app.listen(port)` does).
- Forgetting that **a new task definition revision is needed** to change env vars/image.
- **Health-check grace period too short** for a slow boot → the service kills tasks that were just about to be healthy.

## Troubleshoot — where to look, in order

1. **Service events** (the first place to look; plain English):
   ```bash
   aws ecs describe-services --cluster product-cluster --services product-api-service --query 'services[0].events[:6].message' --output text
   ```
2. **Why did a task stop?**
   ```bash
   aws ecs list-tasks --cluster product-cluster --desired-status STOPPED --query 'taskArns[:3]' --output text | tr '\t' '\n' | tr -d '\r' \
     | xargs -r aws ecs describe-tasks --cluster product-cluster --query 'tasks[].[stoppedReason,containers[0].reason]' --output text --tasks
   ```
3. **Container logs**: `aws logs tail /ecs/product-api --since 15m` (chapter 08).
4. **Target health reason**: `aws elbv2 describe-target-health …` → `Reason: Target.Timeout` (SG/port), `Target.ResponseCodeMismatch` (path/status), `Target.FailedHealthChecks`.

| Stopped reason / symptom | Cause → fix |
|--------------------------|-------------|
| `CannotPullContainerError … i/o timeout` | no NAT route from private subnets (ch. 02) |
| `CannotPullContainerError … not found` | wrong image URI/tag |
| `ResourceInitializationError: failed to … log` / `unable to retrieve secret` | no NAT route, or execution role missing permissions |
| `Essential container exited` + `exec format error` in logs | CPU architecture mismatch |
| Logs: `Missing required environment variable` | task definition lacks an env var → new revision |
| Logs: `AccessDeniedException … GetSecretValue` | task role policy/ARN (ch. 03) |
| Logs: `ETIMEDOUT` to DB | `rds-sg` ← `ecs-sg` rule |
| ALB returns **503** | no healthy targets registered |
| ALB returns **502** | target closed the connection / crashed mid-request (check app logs) |
| ALB returns **504** | target too slow or SG blocks; check `TargetResponseTime` |
| `OutOfMemoryError` / task killed with exit code 137 | memory limit too low → raise `memory` |
