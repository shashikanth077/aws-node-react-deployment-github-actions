# 00 — Prerequisites, cost & safety

## Tools

| Tool | Check | Needed for |
|------|-------|-----------|
| Node.js 22+ | `node -v` | local dev |
| Docker Desktop | `docker version` (both Client **and** Server must print) | image build |
| AWS CLI v2 | `aws --version` | everything |
| Git Bash (Windows) | – | commands in this guide are **bash**. In PowerShell, set variables with `$env:NAME="x"` instead of `export NAME=x`. |

## AWS account safety (do this first)

1. **Never use the root user for daily work.** Create an IAM Identity Center user (preferred) or an IAM user with
   `AdministratorAccess` for this lab, and enable MFA on both root and that user.
2. Configure the CLI and confirm who you are:

```bash
aws configure            # or: aws configure sso
aws sts get-caller-identity
```

Expected output (IDs differ):

```json
{
    "UserId": "AIDAEXAMPLE123456789",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/shashi-admin"
}
```

3. Set the variables used by every later chapter (re-run after opening a new terminal):

```bash
export AWS_REGION=eu-central-1
export AWS_DEFAULT_REGION=$AWS_REGION
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export BUCKET=product-app-$ACCOUNT_ID
echo $ACCOUNT_ID $AWS_REGION
```

> Keep the **console region selector** (top right) on the same region as `AWS_REGION` in every chapter.
> "I can't see my resource" is almost always the wrong region.

## Create a budget alarm (5 minutes, saves surprises)

Console → **Billing and Cost Management → Budgets → Create budget → Use a template → "Monthly cost budget"**,
amount **$10**, your email. You get an email when forecasted or actual spend crosses the thresholds.

## Windows + Git Bash gotchas (found while deploying this for real)

| Symptom | Cause and fix |
|---------|---------------|
| `--log-group-name /ecs/product-api` is sent to AWS as `C:/Program Files/Git/ecs/...` | Git Bash rewrites arguments that start with `/`. Run `export MSYS_NO_PATHCONV=1` first. |
| `docker login` to ECR: `Error saving credentials ... The stub received bad data` | The Windows credential helper cannot store ECR's long token. Skip `docker login`: write the token straight into a throw-away Docker config and push with it (below). |
| `xargs aws ecs describe-tasks` fails with `Unexpected number of separators` | `aws.exe` prints Windows `\r\n` line endings. Pipe through `tr -d '\r'` (and `tr '\t' '\n'` for tab-separated ARNs). |

ECR push without the credential helper:

```bash
CFG='C:\Users\<you>\ecr-docker-config'; mkdir -p "$(cygpath -u "$CFG")"
TOKEN=$(aws ecr get-login-password --region $AWS_REGION)
AUTH=$(printf 'AWS:%s' "$TOKEN" | base64 -w0)
printf '{"auths":{"%s.dkr.ecr.%s.amazonaws.com":{"auth":"%s"}}}' $ACCOUNT_ID $AWS_REGION "$AUTH" > "$(cygpath -u "$CFG")/config.json"
docker --config "$CFG" push $ECR_URI:1.0.0
rm "$(cygpath -u "$CFG")/config.json"      # the file contains a 12-hour password
```

Also: RDS now defaults to **MySQL 8.4** (not 8.0); the app works with both.

## What costs money

Prices change and differ by region — treat the numbers as **rough orders of magnitude** and check the
[AWS pricing pages](https://aws.amazon.com/pricing/) / Pricing Calculator.

How "Free Tier" works depends on **when your account was created**: older accounts get 12 months of specific monthly
allowances (e.g. 750 h of `db.t3.micro`, 750 h of ALB); accounts created recently get a
credits-based free plan instead. Look at *Billing → Free Tier* to see which applies to you.

| Service | Free Tier? | Rough cost if left running |
|---------|------------|----------------------------|
| **NAT Gateway** | ❌ no | ~$1.1/day + data (the biggest line item) |
| **ECS Fargate** (2 × 0.25 vCPU / 0.5 GB) | ❌ no | ~$0.6/day |
| **ALB** | 750 h/month for 12 months on older accounts | ~$0.5–0.6/day otherwise |
| **Public IPv4 addresses** (2 for ALB, 1 for NAT) | partly (older accounts) | ~$0.01/h each → ~$0.4/day |
| RDS MySQL `db.t3.micro`, single-AZ, 20 GB | ✅ 750 h/month, 12 months (older accounts) | ~$0.5/day otherwise |
| Secrets Manager (1 secret) | 30-day trial | ~$0.40/month |
| S3, ECR (≤500 MB), CloudFront (≤1 TB), CloudWatch Logs (≤5 GB) | ✅ | pennies at this scale |

**Total while the whole stack is up: about $2–3/day.** A weekend left on is $5–8; a month is $60–90.

How to keep it low:

- Build in one or two sittings, then **tear down** ([chapter 09](09-troubleshooting-and-cleanup.md)).
- The NAT Gateway is the expensive part. Deleting it (and the Elastic IP) while you are not working stops most of the cost; recreate it before you start ECS tasks again.
- ECS service → *Update → desired tasks = 0* pauses Fargate cost without deleting anything.
- Stop the RDS instance if you pause (AWS restarts it automatically after 7 days).

## How to read each chapter

Every AWS service section uses the same shape:

**What it is → Why this app needs it → How to configure it → How traffic flows through it → How to verify →
Common mistakes → How to troubleshoot.**
