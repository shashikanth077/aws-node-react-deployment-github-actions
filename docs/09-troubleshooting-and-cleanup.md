# 09 — Troubleshooting cheat-sheet & teardown

## Debug by following the request (outside → in)

```
 Browser ─► CloudFront ─► ALB ─► Target group ─► ECS task ─► Node ─► Secrets Manager / RDS
   │            │           │          │             │          │
   DevTools   curl -I     ALB metrics  target health  stopped    CloudWatch Logs
   status     x-cache     5xx counts   reasons       reasons     (Logs Insights)
```

| Symptom | Most likely layer | First command |
|---------|-------------------|---------------|
| Blank page / 403 XML | S3 bucket policy, missing `index.html` | `aws s3 ls s3://$BUCKET/` |
| CloudFront 502 | ALB unreachable from CloudFront | check origin protocol/port, `alb-sg` |
| 503 from ALB | no healthy targets | `aws elbv2 describe-target-health --target-group-arn $TG_ARN` |
| Targets `unhealthy` (`Target.Timeout`) | security group or port | `ecs-sg` ← `alb-sg` :3000; container port 3000 |
| Targets `unhealthy` (`ResponseCodeMismatch`) | wrong path | health path `/health`, success `200` |
| Tasks flap start/stop | container crash or failing health check | `aws ecs describe-services … events`; `aws logs tail` |
| `CannotPullContainerError` | NAT/route or image URI | private route table `0.0.0.0/0 → nat` |
| `500` JSON from API | Node error | Logs Insights `filter level="error"` |
| `ETIMEDOUT` to DB | `rds-sg` | inbound 3306 from `ecs-sg` |
| `ER_ACCESS_DENIED_ERROR` | credentials | secret ARN, rotation, DB user |
| `AccessDeniedException` (secretsmanager) | task role | policy on correct ARN |
| Images 403 | OAC/bucket policy or key mismatch | `aws s3 ls`; compare with `imageUrl` |
| Stale site after deploy | CloudFront cache | invalidate `/index.html` |
| Bill higher than expected | NAT/ALB/Fargate left running | Billing → Cost Explorer, group by service |

**Reachability Analyzer** (VPC console) answers "why can't A reach B?" by naming the blocking rule — use it for any network timeout.

---

## Teardown — delete in this order

Order matters because AWS refuses to delete things that are still in use. Region must match the one you used.
Check each step in the console afterwards (resource lists empty).

```bash
# 1. CloudFront: disable, wait for "Deployed", then delete (console: CloudFront → distribution → Disable → Delete)

# 2. ECS service and cluster
aws ecs update-service --cluster product-cluster --service product-api-service --desired-count 0
aws ecs delete-service --cluster product-cluster --service product-api-service --force
aws ecs delete-cluster --cluster product-cluster

# 3. Load balancer, then target group
aws elbv2 delete-load-balancer --load-balancer-arn $(aws elbv2 describe-load-balancers --names product-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text)
# wait ~1 minute, then:
aws elbv2 delete-target-group --target-group-arn $TG_ARN

# 4. RDS (also deletes the managed secret). Skipping the final snapshot is fine for a lab.
aws rds delete-db-instance --db-instance-identifier product-db --skip-final-snapshot --delete-automated-backups
aws rds wait db-instance-deleted --db-instance-identifier product-db
aws rds delete-db-subnet-group --db-subnet-group-name product-db-subnet-group

# 5. S3 (must be emptied first) and ECR
aws s3 rm "s3://$BUCKET" --recursive && aws s3api delete-bucket --bucket "$BUCKET"
aws ecr delete-repository --repository-name product-api --force

# 6. CloudWatch and monitoring extras
aws logs delete-log-group --log-group-name /ecs/product-api
aws cloudwatch delete-alarms --alarm-names product-unhealthy-hosts product-api-high-cpu
aws sns delete-topic --topic-arn arn:aws:sns:$AWS_REGION:$ACCOUNT_ID:product-alerts

# 7. IAM roles
aws iam delete-role-policy --role-name productApiTaskRole --policy-name read-db-secret
aws iam delete-role --role-name productApiTaskRole
aws iam detach-role-policy --role-name productApiTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name productApiTaskExecutionRole
```

**8. Network (console, VPC):**
1. **NAT gateways** → delete `product-nat…`, wait until *Deleted*.
2. **Elastic IPs** → **Release** the one that belonged to the NAT (an unattached EIP is billed).
3. **Endpoints** → delete the S3 gateway endpoint.
4. **VPC → Delete VPC** (`product-vpc`): it removes the IGW, subnets, route tables and security groups for you. If it complains, delete security groups `alb-sg`, `ecs-sg`, `rds-sg` (in that order: `rds-sg` first) and any leftover ENIs.
5. (If used) Route 53 hosted zone, ACM certificates.

**Final check:** Billing → *Cost Explorer* tomorrow shows ≈ $0/day; *EC2 → Elastic IPs*, *NAT gateways*, *Load balancers*, *RDS*, *ECS clusters* are all empty in your region.

## What to learn next

- Express the whole thing as **Terraform / CloudFormation / CDK** (the console clicks here are the spec).
- **Auto scaling** for the ECS service (target tracking on CPU 60%).
- **Multi-AZ RDS**, one **NAT per AZ**, **VPC endpoints** instead of NAT for ECR/Secrets/Logs at scale.
- **AWS WAF** on CloudFront, restrict `alb-sg` to the CloudFront prefix list.
- CI/CD with [GitHub Actions](10-github-actions.md).
