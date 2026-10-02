# 02 — Networking: VPC, subnets, route tables, IGW, NAT, security groups

Everything else lives *inside* this network, so we build it first.

## The mental model (in simple language)

- **VPC** = your own private data centre inside AWS. Nobody gets in unless you open a door. We use `10.0.0.0/16` (65,536 private IPs).
- **Subnet** = a room in that data centre, pinned to **one Availability Zone** (AZ = a physically separate building).
  We use two AZs so one building failing does not take the app down.
- **Internet Gateway (IGW)** = the front door to the street. Without it, nothing in the VPC can reach the internet and nothing can reach in.
- **Route table** = signposts attached to a subnet: *"to reach address X, go through Y"*. The only thing that makes a
  subnet **public** is a signpost saying *"everything else (`0.0.0.0/0`) → Internet Gateway"*.
- **NAT Gateway** = a one-way mail slot. Private containers can *send out* ("download this image", "fetch this secret") and
  get replies, but strangers on the internet cannot start a conversation with them. The NAT Gateway itself sits in a
  **public** subnet and owns a public IP (an Elastic IP).
- **Security group (SG)** = a firewall around each *resource* (not each subnet). Rules say who may connect in.
  Stateful: replies are allowed automatically.

### Our layout

```
                         Internet
                            │
                     ┌──────┴──────┐
                     │   IGW       │
                     └──────┬──────┘
 VPC 10.0.0.0/16            │
 ┌──────────────────────────┼───────────────────────────────────────────────┐
 │        AZ-A              │                     AZ-B                      │
 │  ┌──────────────────┐    │             ┌──────────────────┐              │
 │  │ public-a         │    │             │ public-b         │              │
 │  │ 10.0.1.0/24      │◄───┴────────────►│ 10.0.3.0/24      │  route: 0.0.0.0/0 → IGW
 │  │ ALB node, NAT GW │                  │ ALB node         │              │
 │  └──────────────────┘                  └──────────────────┘              │
 │  ┌──────────────────┐                  ┌──────────────────┐              │
 │  │ private-app-a    │                  │ private-app-b    │  route: 0.0.0.0/0 → NAT GW
 │  │ 10.0.2.0/24      │                  │ 10.0.4.0/24      │              │
 │  │ ECS task         │                  │ ECS task         │              │
 │  └──────────────────┘                  └──────────────────┘              │
 │  ┌──────────────────┐                  ┌──────────────────┐              │
 │  │ private-db-a     │                  │ private-db-b     │  route: local only (no internet at all)
 │  │ 10.0.5.0/24      │                  │ 10.0.6.0/24      │              │
 │  │ RDS (primary)    │                  │ (standby later)  │              │
 │  └──────────────────┘                  └──────────────────┘              │
 └──────────────────────────────────────────────────────────────────────────┘
```

> Your brief listed four subnets. RDS needs a **subnet group spanning ≥ 2 AZs**, and we want the database in *its own*
> tier with no route to the internet, so we add two DB subnets (`10.0.5.0/24`, `10.0.6.0/24`).

### The three route tables

| Route table | Used by | Routes | Meaning |
|-------------|---------|--------|---------|
| `product-public-rt` | public-a, public-b | `10.0.0.0/16 → local` · `0.0.0.0/0 → igw-…` | internal traffic stays inside; everything else leaves via the front door |
| `product-private-rt` | private-app-a, private-app-b | `10.0.0.0/16 → local` · `0.0.0.0/0 → nat-…` · `S3 prefix list → vpce-…` | outbound only, via NAT; S3 traffic uses a free shortcut |
| `product-db-rt` | private-db-a, private-db-b | `10.0.0.0/16 → local` | the database can talk to the VPC and **nothing else** |

---

## A. Create the VPC, subnets, IGW, NAT (≈ 10 min)

**What it is** — the network described above. **Why this app needs it** — the ALB must be reachable from the internet, but
Node and MySQL must not be. **How to configure it:**

Console → **VPC → Create VPC → "VPC and more"**

| Field | Value |
|-------|-------|
| Name tag auto-generation | `product` (→ names like `product-vpc`) |
| IPv4 CIDR block | `10.0.0.0/16` |
| Number of AZs | 2 (pick two, e.g. `eu-central-1a`, `eu-central-1b`) |
| Number of public subnets | 2 |
| Number of private subnets | 2 |
| **Customize subnets CIDR blocks** | public: `10.0.1.0/24`, `10.0.3.0/24` · private: `10.0.2.0/24`, `10.0.4.0/24` |
| NAT gateways | **In 1 AZ** (cheaper; production uses one per AZ) |
| VPC endpoints | **S3 Gateway** (free; keeps ECR image-layer downloads off the paid NAT) |
| DNS options | enable DNS hostnames **and** DNS resolution |

Click **Create VPC**. The wizard builds the VPC, 4 subnets, the IGW, an Elastic IP, the NAT Gateway, route tables and the S3 endpoint
(NAT takes 1–2 minutes to become *Available*).

Rename for clarity (pencil icon in the *Name* column): the wizard names subnets like `product-subnet-public1-eu-central-1a`.
That is fine — the guide refers to them as `public-a`, `private-app-a` etc.

### Add the two database subnets

VPC → **Subnets → Create subnet** → VPC `product-vpc`, then add two subnets:

| Name | AZ | CIDR |
|------|----|------|
| `private-db-a` | same AZ as public-a | `10.0.5.0/24` |
| `private-db-b` | same AZ as public-b | `10.0.6.0/24` |

VPC → **Route tables → Create route table** → name `product-db-rt`, VPC `product-vpc`. Then
*Subnet associations → Edit* → select both DB subnets. **Do not add any route** other than the automatic `local` one.

## B. Create the three security groups

VPC → **Security groups → Create security group** (VPC: `product-vpc`). Create in this order, because each rule refers to the previous group.

**1. `alb-sg`** — "who may talk to the load balancer"

| Inbound | Source |
|---------|--------|
| HTTP 80 | `0.0.0.0/0` |
| HTTPS 443 | `0.0.0.0/0` (only needed if you add a custom domain later; harmless to add now) |

Outbound: leave default (all).

**2. `ecs-sg`** — "who may talk to Node"

| Inbound | Source |
|---------|--------|
| Custom TCP **3000** | **`alb-sg`** (choose the security group, not an IP range) |

**3. `rds-sg`** — "who may talk to MySQL"

| Inbound | Source |
|---------|--------|
| MYSQL/Aurora **3306** | **`ecs-sg`** |

### Why we do NOT expose 3000 or 3306 to the internet

- **Port 3306 open to the world** is how databases get found by scanners within minutes and brute-forced or ransomed.
  The only thing that ever needs MySQL is Node, so only Node's security group is allowed.
- **Port 3000 open to the world** would let people bypass the load balancer: no health-based routing, no central
  logging/WAF, no TLS policy, and your tasks have no public IP anyway. All traffic should enter through one controlled door (the ALB).
- Referencing a **security group as the source** (instead of an IP range) means rules keep working when tasks come and go
  and their IP addresses change — which on Fargate is constantly.

### The chain, visualised

```
 Internet ──► [ALB-SG  :80/:443 from 0.0.0.0/0] ──► [ECS-SG :3000 from ALB-SG] ──► [RDS-SG :3306 from ECS-SG]
              public subnets                         private-app subnets            private-db subnets
```

## How traffic flows through the network

1. CloudFront (or your browser) connects to the ALB's public IPs in `public-a`/`public-b` through the **IGW**. `alb-sg` allows it.
2. The ALB opens a new connection to a task's **private IP** on port 3000. The route table says `10.0.0.0/16 → local`, so it just crosses the VPC. `ecs-sg` allows it because the source is `alb-sg`.
3. The task connects to RDS on 3306, again `local`. `rds-sg` allows it because the source is `ecs-sg`.
4. When a task needs the outside world (pull image, read Secrets Manager, write logs): `0.0.0.0/0 → NAT` → NAT translates to its Elastic IP → **IGW** → internet. Replies come back the same way. S3 traffic skips the NAT through the gateway endpoint.

## How to verify

```bash
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=product-vpc --query 'Vpcs[0].VpcId' --output text)
aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[].[Tags[?Key==`Name`]|[0].Value,AvailabilityZone,CidrBlock]' --output table
```

Expected (names differ slightly):

```
-----------------------------------------------------------------
|                        DescribeSubnets                        |
+------------------------------------------+--------------+-----+
|  product-subnet-public1-eu-central-1a    | eu-central-1a| 10.0.1.0/24
|  product-subnet-private1-eu-central-1a   | eu-central-1a| 10.0.2.0/24
|  product-subnet-public2-eu-central-1b    | eu-central-1b| 10.0.3.0/24
|  product-subnet-private2-eu-central-1b   | eu-central-1b| 10.0.4.0/24
|  private-db-a                            | eu-central-1a| 10.0.5.0/24
|  private-db-b                            | eu-central-1b| 10.0.6.0/24
```

Even better, console → VPC → **Your VPCs → product-vpc → Resource map**: it draws subnets, route tables and gateways and
shows which subnet uses which route table. Check that:

- both public subnets → a table with a route to `igw-…`
- both private-app subnets → a table with `0.0.0.0/0 → nat-…`
- both DB subnets → a table with **no** `0.0.0.0/0` route
- NAT gateway state is **Available** and lives in a **public** subnet

Collect the IDs you will need later:

```bash
export PRIV_A=<subnet-id of private-app-a>   PRIV_B=<subnet-id of private-app-b>
export PUB_A=<subnet-id of public-a>         PUB_B=<subnet-id of public-b>
export ALB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=alb-sg Name=vpc-id,Values=$VPC_ID --query 'SecurityGroups[0].GroupId' --output text)
export ECS_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=ecs-sg Name=vpc-id,Values=$VPC_ID --query 'SecurityGroups[0].GroupId' --output text)
export RDS_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=rds-sg Name=vpc-id,Values=$VPC_ID --query 'SecurityGroups[0].GroupId' --output text)
```

## Common mistakes

- **NAT Gateway placed in a private subnet.** It must be in a *public* subnet (one with an IGW route), otherwise it cannot reach the internet itself.
- **Forgetting the private route to NAT.** Tasks then fail with `CannotPullContainerError` / `ResourceInitializationError` (timeouts).
- **Using CIDR ranges instead of security groups** as sources for `ecs-sg`/`rds-sg`.
- **Opening 3306 "temporarily" to `0.0.0.0/0`** to connect from your laptop. Use CloudShell in the VPC (chapter 03) instead.
- **DB subnets in the same AZ.** An RDS subnet group needs two AZs.
- **Wrong region** in the console while the CLI is in another.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Tasks cannot pull the image / read secrets (timeout) | Private route table has `0.0.0.0/0 → nat`; NAT is *Available*, in a public subnet; public route table has `0.0.0.0/0 → igw`; Elastic IP attached |
| ALB reachable, targets "unhealthy" with *Request timed out* | `ecs-sg` inbound 3000 from `alb-sg`; container listens on `0.0.0.0:3000` (not 127.0.0.1) |
| Node logs `ETIMEDOUT` to the DB | `rds-sg` inbound 3306 from `ecs-sg`; RDS and tasks are in the same VPC |
| **Reachability Analyzer** | VPC → *Reachability Analyzer*: path from an ENI of a task to the RDS ENI on 3306; it names the exact blocking rule |

**Hardening (optional):** with CloudFront in front, the ALB only needs to accept CloudFront. You can replace the
`0.0.0.0/0` rule on `alb-sg` with the AWS-managed prefix list `com.amazonaws.global.cloudfront.origin-facing`. Caveat: that
list counts as ~55 rules against the default 60-rule SG quota, so it needs its own SG or a quota increase.
