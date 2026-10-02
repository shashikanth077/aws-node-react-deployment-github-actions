# Product List on AWS — React + Node.js + MySQL on ECS Fargate

A hands-on AWS project for an experienced React/Node developer who is new to AWS.
You deploy a deliberately tiny app (a **Product List**) on a realistic AWS architecture:
**VPC → ALB → ECS Fargate (2 tasks, 2 AZs) → RDS MySQL**, with images in **S3**, the image pipeline through **ECR**,
credentials in **Secrets Manager** and logs in **CloudWatch**.

The app is small on purpose. The point is the infrastructure around it.

```
Browser ──► CloudFront ──┬──► S3            React build + product images
                         └──► ALB ─► ECS Fargate (Node, 2 tasks) ─► RDS MySQL
```

---

## What is in this repo

```
.
├── backend/              Node.js 22 + Express API   (GET /api/products, GET /health)
│   ├── Dockerfile        production image (multi-stage, non-root, RDS CA bundle)
│   ├── db/               schema.sql + seed.sql (5 products)
│   └── src/              config, logger, db pool + Secrets Manager, routes, graceful shutdown
├── frontend/             React 19 + TypeScript + Vite   (the product list page)
├── assets/images/        5 sample product images (SVG) -> uploaded to S3
├── infra/                task definition template, IAM policies, ECR lifecycle policy, CI example
├── scripts/              render-task-def.sh (fills placeholders in the task definition)
├── docker-compose.yml    local MySQL + API
└── docs/                 the step-by-step guide (start at 00)
```

## The guide — follow in this order

| # | Chapter | You will build / learn | Cost while running |
|---|---------|------------------------|--------------------|
| 00 | [Prerequisites, cost & safety](docs/00-prerequisites-and-costs.md) | CLI, IAM user, **budget alarm**, what costs money | – |
| 01 | [Run it locally first](docs/01-run-locally.md) | App + MySQL on your laptop | free |
| 02 | [Networking: VPC, subnets, IGW, NAT, security groups](docs/02-networking.md) | The private network everything lives in | **NAT ≈ $1/day** |
| 03 | [RDS MySQL + Secrets Manager](docs/03-rds-and-secrets.md) | Database, no hard-coded password | free tier |
| 04 | [S3 for product images](docs/04-s3-images.md) | Private bucket, uploads | free tier |
| 05 | [Docker + ECR](docs/05-docker-and-ecr.md) | Image build, test, tag, push | free tier |
| 06 | [ECS Fargate + ALB](docs/06-ecs-fargate-alb.md) | Cluster, task definition, service, 2 tasks, load balancer | **Fargate + ALB ≈ $1.5/day** |
| 07 | [React frontend + CloudFront (+ optional HTTPS domain)](docs/07-frontend-cloudfront.md) | Public HTTPS URL, one origin for site + API | free tier |
| 08 | [Monitoring with CloudWatch](docs/08-cloudwatch-monitoring.md) | Find `console.log` output, metrics, alarms | free tier |
| 09 | [Troubleshooting & **teardown**](docs/09-troubleshooting-and-cleanup.md) | Fix-it table; delete everything in the right order | – |
| 10 | [Optional: GitHub Actions deploy](docs/10-github-actions.md) | git push → ECR → ECS | free |

> **Budget warning.** Not everything here is Free Tier (NAT Gateway, Fargate, the ALB's public IPs).
> Running the full stack costs roughly **$2–3 per day**. Do it in one or two sittings and
> follow [chapter 09](docs/09-troubleshooting-and-cleanup.md) when you finish. Details in [chapter 00](docs/00-prerequisites-and-costs.md).

---

## Architecture

### Request flow (what happens when a user opens the site)

```
  User's browser
        │  https://dxxxxxxxx.cloudfront.net
        ▼
  ┌───────────────────────────────┐   Route 53 / DNS: OPTIONAL (only for your own domain)
  │          CloudFront           │   gives free HTTPS on *.cloudfront.net
  └───────┬───────────────┬───────┘
          │ /  and /images/*          │ /api/*
          ▼                           ▼
   ┌─────────────┐        ┌──────────────────────────────────────────────────────────────┐
   │     S3      │        │  VPC 10.0.0.0/16                                             │
   │ index.html  │        │                                                              │
   │ JS / CSS    │        │   PUBLIC subnets            PRIVATE subnets     DB subnets   │
   │ images/*.svg│        │  ┌────────────────┐        ┌───────────────┐   ┌──────────┐  │
   └─────────────┘        │  │ ALB   (ALB-SG) │        │ ECS (ECS-SG)  │   │RDS(RDS-SG)│ │
                          │  │  :80 / :443    │──:3000─►│ Task AZ-A    │   │  MySQL   │  │
                          │  │ AZ-A  + AZ-B   │        │ Task AZ-B ───┼──►│  :3306   │  │
                          │  └────────────────┘        └──────┬────────┘   └──────────┘  │
                          │    ▲ Internet Gateway             │ NAT Gateway (outbound)   │
                          └────┼──────────────────────────────┼──────────────────────────┘
                               │                              ▼
                               │                  ECR (image pull) · Secrets Manager · CloudWatch Logs
```

### Deployment flow (how code becomes running containers)

```
 Developer ─► git push / local
                 │
                 ▼
          docker build  ──►  Docker image  ──►  ECR  (product-api:1.0.0)
                                                  │
                                                  ▼
                              ECS Task Definition  (revision N: image, CPU, env, roles)
                                                  │
                                                  ▼
                              ECS Service (desired = 2)  ── rolling deploy ──►  new Fargate tasks
                                                                                 (ALB drains old ones)
```

### Supporting services

```
 Secrets Manager  ──►  DB username/password  ──►  read by Node at startup using the ECS TASK ROLE
 CloudWatch Logs  ◄──  every console.log / console.error from every task
 CloudWatch Metrics ◄─ ALB (requests, 5xx, latency, healthy hosts) + ECS (CPU, memory)
 IAM              ──►  Execution role (ECS pulls image, writes logs) · Task role (app reads the secret)
```

### Security groups — who may talk to whom

```
 Internet ──► ALB-SG :80/:443 ──► ECS-SG :3000 ──► RDS-SG :3306
  anyone         only the ALB          only ALB-SG        only ECS-SG
```

---

## Names used throughout the guide

Use these exactly, so every command in the docs works unchanged.

| Thing | Name / value |
|-------|--------------|
| Region (any works) | `eu-central-1` |
| VPC | `product-vpc` — `10.0.0.0/16` |
| Public subnets (ALB, NAT) | `public-a` `10.0.1.0/24` (AZ-A) · `public-b` `10.0.3.0/24` (AZ-B) |
| Private app subnets (ECS) | `private-app-a` `10.0.2.0/24` · `private-app-b` `10.0.4.0/24` |
| Private DB subnets (RDS) | `private-db-a` `10.0.5.0/24` · `private-db-b` `10.0.6.0/24` |
| Security groups | `alb-sg` · `ecs-sg` · `rds-sg` |
| RDS | instance `product-db`, database `productsdb`, subnet group `product-db-subnet-group` |
| S3 bucket | `product-app-<ACCOUNT_ID>` |
| ECR repository | `product-api` |
| ECS | cluster `product-cluster` · task family `product-api` · service `product-api-service` |
| Load balancer | `product-alb` · target group `product-api-tg` |
| IAM roles | `productApiTaskExecutionRole` · `productApiTaskRole` |
| Log group | `/ecs/product-api` |

## Honest design notes

- **ALB :443?** An HTTPS listener on the ALB needs a certificate, which needs a domain name you own.
  To keep the lab domain-free, **CloudFront terminates HTTPS** (free `*.cloudfront.net` certificate) and talks HTTP to the ALB.
  [Chapter 07](docs/07-frontend-cloudfront.md) has an optional section that adds a domain, ACM certificate and ALB `:443`.
- **Database is single-AZ** to stay within Free Tier. The *application* tier is highly available (2 tasks, 2 AZs). Multi-AZ RDS is one checkbox when you want it.
- **One NAT Gateway** (not one per AZ) to save money. Production uses one per AZ.
- Console clicks are used for creating resources (you learn where things are); the AWS CLI is used for verification and
  anything repeatable (push image, register task definition, deploy).
