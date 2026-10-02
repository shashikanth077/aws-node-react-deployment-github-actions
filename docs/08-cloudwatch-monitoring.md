# 08 — Monitoring with CloudWatch

**What it is.** CloudWatch is AWS's built-in observability service: **Logs** (text lines), **Metrics** (numbers over time),
**Alarms** (notify when a metric misbehaves).

**Why this app needs it.** Containers are disposable and have no SSH. When a task dies, its local files die with it. If it
isn't in CloudWatch, it's gone. Also, with two tasks, "which one served that request?" needs a central place.

```
 console.log(...)  ─► container stdout/stderr ─► awslogs driver (task definition) ─► CloudWatch Log group /ecs/product-api
                                                                                     └─ stream  ecs/product-api/<task-id>
 ALB ─► metrics (requests, 5xx, latency, healthy hosts)   ┐
 ECS ─► metrics (CPU %, memory %)                          ├─► CloudWatch Metrics ─► Alarms ─► SNS email
```

No agent, no code change: our logger calls `console.log`, Docker captures stdout, the `awslogs` log driver forwards it. The only
requirements: `logConfiguration` in the task definition, and the **execution role** allowed to write logs (it is, via the managed policy).

## Find your `console.log()` output

**Console:** CloudWatch → **Logs → Log groups → `/ecs/product-api`** → pick a **log stream** (`ecs/product-api/<task-id>`; one per task — two tasks, two streams) → lines appear with timestamps.
Tip: *Search all log streams* in the group gives you both tasks together.

**CLI** (like `docker logs -f`):

```bash
aws logs tail /ecs/product-api --follow --since 10m
aws logs tail /ecs/product-api --since 1h --filter-pattern '"level":"error"'
```

Generate something to look at:

```bash
for i in 1 2 3; do curl -s https://$CF_DOMAIN/api/products > /dev/null; done
```
```
ecs/product-api/8a1c… {"time":"2026-10-02T12:41:07.511Z","level":"info","msg":"request","requestId":"Root=1-67…","method":"GET","path":"/api/products","status":200,"ms":6.4,"ip":"203.0.113.9"}
```
(ALB health checks are filtered out of the log in `app.js` so they do not drown the signal.)

Logs appear within a few seconds. **No logs at all?** → log group name mismatch with the task definition, execution role lacking `logs:CreateLogStream/PutLogEvents`, or the task never started (check *stopped reason*, chapter 06).

## Logs Insights — SQL-like queries over JSON logs

CloudWatch → **Logs Insights** → select `/ecs/product-api` → time range → run. Because we log JSON, fields are auto-discovered.

```
# Errors, newest first
fields @timestamp, msg, err.message, requestId
| filter level = "error"
| sort @timestamp desc
| limit 50
```
```
# Slowest endpoints, latency percentiles per 5 minutes
filter msg = "request"
| stats count() as requests, avg(ms) as avg_ms, pct(ms, 95) as p95_ms by bin(5m)
```
```
# Everything that happened for one request
fields @timestamp, msg, status
| filter requestId = "Root=1-67..."
| sort @timestamp asc
```
```
# 5xx by path
filter msg = "request" and status >= 500
| stats count() by path
```

## Metrics

### ALB (CloudWatch → Metrics → ApplicationELB → *Per AppELB, per TG Metrics*)

| Metric | Healthy looks like | Tells you |
|--------|--------------------|-----------|
| `RequestCount` | follows your traffic | load |
| `TargetResponseTime` (p95/avg) | < 0.3 s here | slow app/DB |
| `HTTPCode_Target_5XX_Count` | 0 | **your app** returned 5xx |
| `HTTPCode_ELB_5XX_Count` | 0 | **ALB** failed: 502/503/504 (no healthy targets, timeouts) |
| `HealthyHostCount` | 2 | tasks passing health checks |
| `UnHealthyHostCount` | 0 | tasks failing |

### ECS (CloudWatch → Metrics → ECS → *ClusterName, ServiceName*)

`CPUUtilization` and `MemoryUtilization` (% of what the task definition reserves). Sustained CPU > 70% → raise `cpu` or add tasks;
memory trending to 80%+ → raise `memory` (OOM kills show up as exit code 137 and `OutOfMemoryError` stopped reasons).

Quick look from the CLI:

```bash
aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=product-cluster Name=ServiceName,Value=product-api-service \
  --start-time $(date -u -d '-30 min' +%FT%TZ) --end-time $(date -u +%FT%TZ) --period 300 --statistics Average Maximum
```

## Alarms (so you find out before your users do)

```bash
aws sns create-topic --name product-alerts
aws sns subscribe --topic-arn arn:aws:sns:$AWS_REGION:$ACCOUNT_ID:product-alerts --protocol email --notification-endpoint you@example.com
# confirm the subscription email, then:

ALB_DIM=$(aws elbv2 describe-load-balancers --names product-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text | sed 's#.*:loadbalancer/##')
TG_DIM=$(echo $TG_ARN | sed 's#.*:##')

aws cloudwatch put-metric-alarm --alarm-name product-unhealthy-hosts \
  --namespace AWS/ApplicationELB --metric-name UnHealthyHostCount --statistic Maximum \
  --dimensions Name=LoadBalancer,Value=$ALB_DIM Name=TargetGroup,Value=$TG_DIM \
  --period 60 --evaluation-periods 2 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions arn:aws:sns:$AWS_REGION:$ACCOUNT_ID:product-alerts

aws cloudwatch put-metric-alarm --alarm-name product-api-high-cpu \
  --namespace AWS/ECS --metric-name CPUUtilization --statistic Average \
  --dimensions Name=ClusterName,Value=product-cluster Name=ServiceName,Value=product-api-service \
  --period 300 --evaluation-periods 2 --threshold 80 --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:$AWS_REGION:$ACCOUNT_ID:product-alerts
```

The first 10 alarms and 5 GB of log ingestion per month are in the always-free tier.

## Error investigation playbook — "the site shows an error"

```
 1. Browser DevTools → Network → /api/products status?
      ├─ CloudFront 502/504 page ──► ALB unreachable or slow: ALB metrics + alb-sg (ch. 07)
      ├─ 503 from ALB ─────────────► HealthyHostCount = 0 → ECS service events, stopped tasks (ch. 06)
      ├─ 500 JSON {"error":"Internal server error"} ──► app error: step 2
      └─ 200 but empty/wrong ──────► data issue: query the DB via CloudShell (ch. 03)
 2. Logs Insights:  filter level = "error"  → read err.message / err.code
      ├─ ETIMEDOUT / ECONNREFUSED   → rds-sg / DB status
      ├─ ER_ACCESS_DENIED_ERROR     → secret / rotation (self-heals once; if repeated, check secret ARN)
      ├─ AccessDeniedException      → task role policy
      └─ nothing at all             → request never reached Node → ALB/target health
 3. ECS → service → Events tab, and task "Stopped reason"
 4. CPU/memory graphs around the incident time (OOM? CPU saturated?)
```

## Common mistakes

- **No log retention** → growing bill. Keep it at 7–14 days for labs.
- **Logging secrets or whole request bodies** (our logger deliberately logs no credentials/bodies).
- Using unstructured `console.log("something", obj)` → can't filter. Log JSON.
- Alarms without an SNS **confirmed** subscription → silent.
- Looking at the wrong log group/region/time range in the console.

## Troubleshoot monitoring itself

| Symptom | Fix |
|---------|-----|
| Log group exists, no streams | Task never reached `RUNNING`, or the execution role cannot write logs |
| `ResourceNotFoundException: log group does not exist` at task start | Create `/ecs/product-api` first (chapter 06 step 1) |
| Metrics graph empty | Wrong dimensions (ALB dimension is the part after `loadbalancer/`), wrong region, or no traffic yet |
