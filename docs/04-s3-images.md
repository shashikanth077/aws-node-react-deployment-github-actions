# 04 — S3 for product images (and the React build)

**What it is.** S3 is object storage: a bucket of files addressed by a **key** (`images/headphones.svg`). Practically unlimited, very cheap, 11 nines of durability.

**Why this app needs it.** Images do not belong in MySQL (bloats the DB, slow, expensive) or in the Docker image (every
image change would need a redeploy). The DB row stores only the **key**; S3 stores the bytes; the browser downloads them
**straight from S3/CloudFront**, so the Node containers never serve an image byte.

```
 products row:  image_key = "images/headphones.svg"
                     │
 API builds URL:     ▼   IMAGE_BASE_URL + "/" + key   →  /images/headphones.svg   (same origin via CloudFront)
 Browser ──GET /images/headphones.svg──► CloudFront ──► S3 (private bucket, via Origin Access Control)
```

We use **one bucket**, two areas: `images/…` (product pictures) and the root (`index.html`, `assets/…` — the React build, chapter 07).

## Configure

Console → **S3 → Create bucket** (or CLI):

```bash
aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
# (in us-east-1 omit --create-bucket-configuration)

aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Settings that matter: **Block all public access = ON** (keep it), default encryption SSE-S3 (on by default), ACLs disabled.
The bucket name must be globally unique — that is why we suffix the account ID.

Upload the sample images:

```bash
aws s3 sync assets/images "s3://$BUCKET/images" --cache-control "public, max-age=86400"
```
```
upload: assets/images/backpack.svg to s3://product-app-123456789012/images/backpack.svg
upload: assets/images/headphones.svg to s3://product-app-123456789012/images/headphones.svg
...
```

> Why not make the bucket public? A public bucket works, but you pay for every hotlink, cannot add HTTPS on your own
> domain, and one wrong policy leaks everything. A **private** bucket behind CloudFront (Origin Access Control) is the
> standard pattern. The bucket policy that grants CloudFront read access is added in [chapter 07](07-frontend-cloudfront.md).

## How traffic flows

Users never talk to the bucket directly. CloudFront signs requests to S3 on their behalf (OAC); S3 only trusts that one
distribution. Cached copies are served from edge locations, so S3 sees very few requests.

## Verify

```bash
aws s3 ls "s3://$BUCKET/images/"
# A time-limited link proves the object is readable while the bucket stays private:
aws s3 presign "s3://$BUCKET/images/headphones.svg" --expires-in 300
```
Open the presigned URL in a browser: you should see the headphones illustration. Opening the plain
`https://$BUCKET.s3.amazonaws.com/images/headphones.svg` URL must give **AccessDenied** — that is correct.

## Common mistakes

- Turning off *Block Public Access* "to make it work".
- Uploading with the wrong prefix (`headphones.svg` instead of `images/headphones.svg`): DB keys and S3 keys must match exactly (case-sensitive).
- Putting the key with a leading `/` in the DB.
- Long `Cache-Control` on files you later overwrite — browsers keep the old picture. Use new file names or invalidate CloudFront.
- Bucket in a different region than expected (it does not matter for CloudFront, but it matters for your CLI commands).

## Troubleshoot

| Symptom | Cause |
|---------|-------|
| `AccessDenied` via CloudFront | Bucket policy for the distribution missing or points to a different distribution ARN (chapter 07) |
| `403` for a file that does not exist | Without `s3:ListBucket`, S3 returns 403 instead of 404 — check the key spelling |
| `NoSuchBucket` | Wrong region/typo in `$BUCKET` |
| Image shows a broken icon in the app | Compare `curl /api/products` `imageUrl` with `aws s3 ls` keys |
