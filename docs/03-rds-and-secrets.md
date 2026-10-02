# 03 — RDS MySQL + Secrets Manager

## RDS MySQL

**What it is.** A managed MySQL server: AWS patches it, backs it up and replaces the hardware. You never log into the OS.

**Why this app needs it.** Products must live somewhere durable and shared. Containers are disposable — each Fargate task
has throw-away storage — so state belongs in a database outside them. Both tasks read the same rows.

### Configure it

**1. Subnet group** — tells RDS *which subnets* it may use.
Console → **RDS → Subnet groups → Create DB subnet group**

| Field | Value |
|-------|-------|
| Name | `product-db-subnet-group` |
| VPC | `product-vpc` |
| AZs | both |
| Subnets | `private-db-a` (10.0.5.0/24), `private-db-b` (10.0.6.0/24) |

**2. Database** — RDS → **Create database** → *Standard create*

| Field | Value |
|-------|-------|
| Engine | MySQL 8.0.x (latest 8.0 minor) |
| Templates | **Free tier** (if offered; otherwise *Dev/Test*) |
| Availability | Single DB instance (Multi-AZ is not free) |
| DB instance identifier | `product-db` |
| Master username | `admin` |
| Credentials management | **Managed in AWS Secrets Manager** ← important, no password for you to invent or leak |
| Instance class | `db.t3.micro` (or `db.t4g.micro`) |
| Storage | gp3 (or gp2), 20 GiB, **disable storage autoscaling** |
| VPC / Subnet group | `product-vpc` / `product-db-subnet-group` |
| **Public access** | **No** |
| VPC security group | choose existing → **`rds-sg`** (remove `default`) |
| Additional config → **Initial database name** | `productsdb` |
| Backup retention | 1 day |
| Performance Insights, Enhanced monitoring | off (they cost money / are not needed) |
| Encryption | on (default) |

Create it. It takes ~5–10 minutes to become **Available**.

### How traffic flows

```
 Node task (private-app-a) ──TCP 3306, TLS──► RDS endpoint product-db.xxxx.eu-central-1.rds.amazonaws.com
                                              resolves to a PRIVATE IP in private-db-a
```
The endpoint is a DNS name: always use it (never the IP — it changes on failover).

### Verify

```bash
aws rds describe-db-instances --db-instance-identifier product-db \
  --query 'DBInstances[0].[DBInstanceStatus,Endpoint.Address,PubliclyAccessible,MultiAZ,MasterUserSecret.SecretArn]' \
  --output text
```
```
available   product-db.cxxxxxxxx.eu-central-1.rds.amazonaws.com   False   False   arn:aws:secretsmanager:eu-central-1:123456789012:secret:rds!db-1a2b3c4d-....-AbCdEf
```

Save the two values:

```bash
export DB_HOST=$(aws rds describe-db-instances --db-instance-identifier product-db --query 'DBInstances[0].Endpoint.Address' --output text)
export DB_SECRET_ARN=$(aws rds describe-db-instances --db-instance-identifier product-db --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
```

The table and sample data are created in [chapter 06](06-ecs-fargate-alb.md#4-initialise-the-database-one-off-task) by running the *same* container image once.

### Common mistakes

- **Public access = Yes** (or default SG) — the DB is then reachable (or at least addressable) from outside. Keep it private + `rds-sg`.
- Forgetting the **initial database name** → `Unknown database 'productsdb'` (fix: connect and `CREATE DATABASE productsdb;`).
- Choosing a non-free-tier instance class or Multi-AZ by accident.
- Large pool × many tasks exceeding `max_connections`.

### Troubleshoot

| Symptom | Fix |
|---------|-----|
| `ETIMEDOUT` | Security group: `rds-sg` must allow 3306 from `ecs-sg`; task must run with `ecs-sg` |
| `ER_ACCESS_DENIED_ERROR` | Wrong/rotated password → see rotation note below |
| `Unknown database` | See above |
| `self-signed certificate in certificate chain` | `DB_SSL=true` but CA bundle missing → image must contain `/app/certs/rds-global-bundle.pem` (our Dockerfile adds it) |
| Want to look inside the DB | CloudShell VPC environment (below) |

### Optional: poke around the database from CloudShell

The DB has no public address, so use a shell **inside** the VPC. Console → **CloudShell → Actions → Create VPC environment**:
VPC `product-vpc`, subnet `private-app-a`, security group **`ecs-sg`** (it is the one `rds-sg` trusts). Then:

```bash
sudo dnf install -y mariadb105
SECRET=$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET_ARN" --query SecretString --output text)
mysql -h <DB endpoint> -u admin -p"$(echo $SECRET | jq -r .password)" productsdb -e 'SELECT id,name,price,image_key FROM products;'
```

---

## Secrets Manager

**What it is.** An encrypted vault for credentials, with IAM-controlled access, audit logs (CloudTrail) and optional rotation.

**Why this app needs it.** The MySQL username/password must not be in Git, in the Docker image, or in plain task-definition
text (anyone who can *read* the task definition could read it). With Secrets Manager the password lives in one place and is
handed only to the identity that needs it.

The RDS option **"Managed in AWS Secrets Manager"** already created the secret for you (`rds!db-…`). Its value:

```json
{ "username": "admin", "password": "…random 30+ chars…" }
```

AWS **rotates this password automatically every 7 days** — which matters for the design below.

### How Node obtains the credentials (IAM roles, no keys)

Two different IAM roles are involved. They are the most confusing part of ECS, so here is the difference:

| Role | Who uses it | Used for | In this project |
|------|-------------|----------|-----------------|
| **Task execution role** | **ECS agent** (before your code starts) | pull image from ECR, create log streams, (optionally) inject secrets | `productApiTaskExecutionRole` → managed policy `AmazonECSTaskExecutionRolePolicy` |
| **Task role** | **Your Node code** (while it runs) | any AWS API call the app makes | `productApiTaskRole` → inline policy: `secretsmanager:GetSecretValue` on **this one secret** |

Flow when a task starts:

```
 1. ECS (execution role) ─► pulls image from ECR, creates log stream           [needs NAT/endpoint]
 2. Node starts, config.js reads DB_HOST, DB_SECRET_ARN from env (not secret values)
 3. AWS SDK in Node asks the container credentials endpoint (169.254.170.2) ─► temporary keys for productApiTaskRole
 4. Node ─► Secrets Manager GetSecretValue(DB_SECRET_ARN)                      [via NAT]
 5. IAM checks: is this role allowed GetSecretValue on THAT ARN?  yes ─► returns {username,password}
 6. Node creates the mysql2 connection pool with those credentials ─► RDS
```

There are **no access keys** anywhere: the temporary credentials are issued to the task, rotate automatically, and are
useless outside it. The relevant code is [`backend/src/db.js`](../backend/src/db.js).

**Why not just inject the secret as an environment variable?** ECS supports it:

```json
"secrets": [{ "name": "DB_PASSWORD", "valueFrom": "<secret-arn>:password::" }]
```
and it needs the *execution* role to have `secretsmanager:GetSecretValue`. It is simpler, and fine for secrets that never rotate.
But the value is read **once at task start**; after the 7-day rotation, running tasks keep a stale password and new
connections fail until you redeploy. Our code reads the secret itself and, on `ER_ACCESS_DENIED_ERROR`, re-reads it and
rebuilds the pool, so rotation is a non-event. It also teaches the task-role pattern you will use for S3, SQS, etc.

### Configure (IAM roles — do now, used in chapter 06)

```bash
# 1) Execution role
aws iam create-role --role-name productApiTaskExecutionRole \
  --assume-role-policy-document file://infra/ecs-tasks-trust-policy.json
aws iam attach-role-policy --role-name productApiTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# 2) Task role (least privilege: one action, one secret)
aws iam create-role --role-name productApiTaskRole \
  --assume-role-policy-document file://infra/ecs-tasks-trust-policy.json
bash scripts/render-task-role-policy.sh > infra/task-role-policy.rendered.json   # needs $DB_SECRET_ARN
aws iam put-role-policy --role-name productApiTaskRole \
  --policy-name read-db-secret --policy-document file://infra/task-role-policy.rendered.json
```

The *trust policy* says **who may assume the role** (`ecs-tasks.amazonaws.com` — i.e., ECS tasks). The *permission policy* says **what the role may do**.

### Verify

```bash
aws iam get-role-policy --role-name productApiTaskRole --policy-name read-db-secret --query PolicyDocument
aws iam list-attached-role-policies --role-name productApiTaskExecutionRole
# Your own admin identity can read the secret to prove it exists (do not paste the output anywhere):
aws secretsmanager describe-secret --secret-id "$DB_SECRET_ARN" --query '[Name,RotationEnabled]'
```
Later, in the container logs (chapter 08) you will see `"msg":"db_credentials_loaded","source":"secrets-manager"` — and **never** the password.

### Common mistakes

- Putting the password in `environment` (plaintext), in the Dockerfile, or in Git.
- Giving the **task role** `secretsmanager:*` on `*`. Scope it to the ARN (the secret ARN ends with a random suffix, so use the full ARN as returned by RDS).
- Confusing execution vs task role: *"AccessDeniedException … not authorized to perform secretsmanager:GetSecretValue"* from **Node** → fix the **task** role. The same error shown as a *task startup failure* ("unable to pull secrets") → fix the **execution** role.
- Forgetting the network path: Secrets Manager is a public AWS endpoint; private tasks reach it through the **NAT Gateway** (or a VPC interface endpoint, ~$7/month per AZ).

### Troubleshoot

| Log / error | Meaning |
|-------------|---------|
| `AccessDeniedException ... secretsmanager:GetSecretValue` | Task role policy missing/wrong ARN |
| `CredentialsProviderError` / `Could not load credentials` | Task has no `taskRoleArn` in its definition |
| `getaddrinfo ENOTFOUND secretsmanager...` / timeout | No NAT route from the private subnets |
| `ER_ACCESS_DENIED_ERROR` repeatedly | Secret belongs to a different DB, or `DB_NAME`/host wrong |
