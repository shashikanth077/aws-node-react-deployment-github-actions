# 10 — Optional: deploy with GitHub Actions

Goal: `git push` → build image → push to ECR → new ECS task definition revision → rolling deploy. Do this **after** the
manual deployment works; automation of something you don't understand just hides the failures.

```
 git push (master, backend/** changed)
   └─► GitHub Actions runner
         ├─ OIDC: assume AWS role (no stored keys)
         ├─ docker build + push  ECR  product-api:<git-sha>
         ├─ render infra/task-definition.json with the new image
         └─ ECS deploy (rolling, waits for stability, circuit-breaker rollback)
```

The workflow template is [`infra/github-actions-deploy.yml.example`](../infra/github-actions-deploy.yml.example).
It is intentionally **not** in `.github/workflows/` so nothing runs (and fails) until you set it up.

## 1. Let GitHub assume an AWS role (OIDC — no access keys)

1. IAM → **Identity providers → Add provider** → *OpenID Connect* → URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. IAM → **Roles → Create role** → *Web identity* → that provider → name `github-deploy-product-api`, with trust condition limiting it to your repo:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:shashikanth077/aws-node-react-deployment-github-actions:ref:refs/heads/master" }
    }
  }]
}
```

3. Permissions for that role (least privilege sketch): ECR push to `product-api`; `ecs:RegisterTaskDefinition`, `ecs:DescribeServices`, `ecs:UpdateService`, `ecs:DescribeTaskDefinition` ; and `iam:PassRole` **only** for `productApiTaskExecutionRole` and `productApiTaskRole`.

## 2. Add repository secrets

GitHub → Settings → Secrets and variables → Actions: `AWS_DEPLOY_ROLE_ARN`, `AWS_ACCOUNT_ID`, `DB_HOST`, `DB_SECRET_ARN`.
(`DB_SECRET_ARN` is only a pointer; the password itself never leaves AWS.)

## 3. Enable it

```bash
mkdir -p .github/workflows
cp infra/github-actions-deploy.yml.example .github/workflows/deploy.yml
git add .github && git commit -m "ci: deploy backend to ECS" && git push
```

Verify: GitHub → Actions → the run goes green; ECS service shows a new task-definition revision with image tag = commit SHA; `curl https://$CF_DOMAIN/api/products` still answers throughout.

## Common mistakes

- `Not authorized to perform sts:AssumeRoleWithWebIdentity` → the `sub` condition does not match the repo/branch exactly.
- `iam:PassRole` missing → `register-task-definition` fails.
- Workflow forgets `permissions: id-token: write`.
- Using `latest` instead of the commit SHA tag → nothing visibly changes in ECS.
