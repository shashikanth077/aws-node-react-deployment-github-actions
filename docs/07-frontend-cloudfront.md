# 07 — React frontend + CloudFront (+ optional custom domain / HTTPS on the ALB)

**What it is.** CloudFront is AWS's CDN: ~hundreds of edge locations that cache and proxy your content over HTTPS.

**Why this app needs it.** Three problems solved at once, with no domain name:

1. **HTTPS for free** on `https://dxxxx.cloudfront.net`. (An ALB `:443` listener needs a certificate, which needs a domain.)
2. **One origin for everything**, so the browser sees a single site: `/` and `/images/*` → S3, `/api/*` → ALB. No CORS, no mixed-content errors (an HTTPS page may not call an HTTP API).
3. **Private S3**: only CloudFront may read the bucket.

```
 Browser ──HTTPS──► CloudFront ──┬── default (*)  ─► S3 bucket   index.html, assets/*, images/*   (cached, OAC)
                                 └── /api/*       ─► ALB :80 ─► ECS tasks                       (never cached)
```

## 1. Build and upload the React app

```bash
cd frontend
npm ci && npm run build            # → dist/  (index.html + hashed JS/CSS)
cd ..
# upload everything except images/, which the images sync (chapter 04) manages
aws s3 sync frontend/dist "s3://$BUCKET" --delete --exclude "images/*" \
  --cache-control "public, max-age=31536000, immutable" --exclude "index.html"
aws s3 cp frontend/dist/index.html "s3://$BUCKET/index.html" --cache-control "no-cache"
aws s3 ls "s3://$BUCKET/"
```

Why two commands: Vite names JS/CSS with a content hash (`index-YEUI1bVh.js`), so they can be cached for a year;
`index.html` points at them and must always be re-checked (`no-cache`), otherwise users keep an old app.

`VITE_API_BASE_URL` stays empty: the app calls `/api/products` on whatever origin served it — CloudFront.

## 2. Create the distribution

Console → **CloudFront → Create distribution**

**Origin 1 — the bucket**

| Field | Value |
|-------|-------|
| Origin domain | your S3 bucket (choose the `…s3.<region>.amazonaws.com` entry, **not** the "website endpoint") |
| Origin access | **Origin access control settings (recommended)** → *Create new OAC* (defaults: sign requests) |
| Default root object | `index.html` |

**Default behavior (`*`)**: viewer protocol *Redirect HTTP to HTTPS*; allowed methods GET, HEAD; cache policy **CachingOptimized**.
Price class: *Use only North America and Europe* (cheapest). WAF: not enabled (extra cost).

Create the distribution. At the top, CloudFront shows **"Copy policy"** for the bucket — go to S3 → bucket → *Permissions → Bucket policy* and paste it. It looks like:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontRead",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::product-app-123456789012/*",
    "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::123456789012:distribution/E1ABCDEF234567" } }
  }]
}
```

**Origin 2 — the load balancer** → distribution → *Origins → Create origin*

| Field | Value |
|-------|-------|
| Origin domain | `$ALB_DNS` (the `…elb.amazonaws.com` name) |
| Protocol | **HTTP only**, port 80 *(TLS ends at CloudFront; ALB↔CloudFront travels over AWS's network. For HTTPS end-to-end, use the custom-domain section below)* |

**Behavior for the API** → *Behaviors → Create behavior*

| Field | Value |
|-------|-------|
| Path pattern | `/api/*` |
| Origin | the ALB origin |
| Viewer protocol policy | Redirect HTTP to HTTPS |
| Allowed HTTP methods | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE (ready for future write endpoints) |
| Cache policy | **CachingDisabled** (APIs must not be cached until you design caching deliberately) |
| Origin request policy | **AllViewerExceptHostHeader** (forwards headers, query strings; ALB must receive its *own* host name) |

Wait until the distribution **Status = Deployed** (3–10 minutes).

> Do **not** add "custom error responses 403/404 → /index.html" (the usual SPA trick): it applies to *all* behaviors and would turn API 404s into HTML pages. This app has a single page, so it is not needed.

```bash
export CF_DOMAIN=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Origins.Items[].DomainName, '$BUCKET')].DomainName | [0]" --output text)
echo https://$CF_DOMAIN
```

## How traffic flows

```
 GET /                      → CloudFront edge → (cache miss) → S3 index.html            via OAC-signed request
 GET /assets/index-….js     → edge cache (1 year)
 GET /images/lamp.svg       → edge cache → S3 images/lamp.svg
 GET /api/products          → edge (no cache) → ALB:80 → ECS task → RDS → JSON back the same way
```
The viewer connection is HTTPS everywhere; the page and API share one origin.

## Verify

```bash
curl -sI https://$CF_DOMAIN/                       | head -n 5     # HTTP/2 200, content-type: text/html, x-cache: Miss/Hit from cloudfront
curl -s  https://$CF_DOMAIN/api/products | head -c 250
curl -sI https://$CF_DOMAIN/images/headphones.svg  | head -n 4     # 200 image/svg+xml
curl -sI http://$BUCKET.s3.amazonaws.com/images/headphones.svg | head -n 1   # 403 → bucket really is private
```
Then open `https://<CF_DOMAIN>` in a browser: five product cards, images from `/images/…`.
DevTools → Network: `products` → **Headers** show `via: … (CloudFront)` and `x-cache: Miss from cloudfront` (API is never a Hit).

Deploying a frontend change later:

```bash
npm --prefix frontend run build
aws s3 sync frontend/dist "s3://$BUCKET" --delete --exclude "images/*" --exclude "index.html" --cache-control "public, max-age=31536000, immutable"
aws s3 cp frontend/dist/index.html "s3://$BUCKET/index.html" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id <ID> --paths "/index.html"
```

## Common mistakes

- Using the S3 **website endpoint** as origin → OAC does not work with it (and website endpoints are HTTP only).
- Forgetting the **bucket policy** → every request returns 403 `AccessDenied`.
- `/api/*` behavior using the default CachingOptimized policy → stale API responses.
- Origin request policy that forwards the **Host** header to the ALB (fine for a plain ALB, breaks setups with host-based rules/certs).
- Origin protocol **HTTPS only** to an ALB that only has an HTTP listener → CloudFront 502.
- Expecting changes to appear instantly: CloudFront caches; invalidate `/index.html`.

## Troubleshoot

| Symptom | Cause / fix |
|---------|-------------|
| `403 AccessDenied` XML for `/` | Bucket policy missing / wrong distribution ARN; or `index.html` not uploaded |
| `502 Bad Gateway` (CloudFront error page) on `/api/*` | CloudFront can't reach the ALB: origin protocol/port, `alb-sg` inbound 80 |
| `503/504` from `/api/*` with JSON body from ALB | no healthy targets → chapter 06 |
| Page loads, products show error + retry | open DevTools → Network → status of `/api/products` |
| Images broken, API fine | key mismatch (chapter 04) or bucket policy |
| Old page after deploy | invalidate `/index.html`; hard reload |

---

## Optional: your own domain, Route 53, HTTPS on the ALB (`:443`)

Needs a domain (≈ $12+/year) and, if hosted in Route 53, $0.50/month per hosted zone. Skip it unless you want it.

```
 User ─► Route 53 (A/ALIAS app.example.com → CloudFront) ─► CloudFront (ACM cert, us-east-1) ─► ALB :443 (ACM cert, same region as ALB) ─► ECS
```

1. **Route 53** → create a hosted zone for your domain (or use your registrar's DNS and add records there).
2. **ACM** (Certificate Manager): request a public certificate
   - for CloudFront: **in `us-east-1`** for `app.example.com`;
   - for the ALB: in **your ALB's region** for `api-origin.example.com`.
   Validate with the DNS CNAME records ACM shows (button "Create records in Route 53").
3. **ALB**: add listener **HTTPS :443** → forward to `product-api-tg`, select the ACM certificate, policy `ELBSecurityPolicy-TLS13-1-2-2021-06`. Optionally change the HTTP :80 listener to redirect to 443. `alb-sg` already allows 443.
4. **Route 53**: `api-origin.example.com` → ALIAS to the ALB.
5. **CloudFront**: edit the ALB origin → domain `api-origin.example.com`, protocol **HTTPS only**. Edit the distribution → *Alternate domain name* `app.example.com` + the `us-east-1` certificate.
6. **Route 53**: `app.example.com` → ALIAS A/AAAA → the CloudFront distribution.

Verify: `curl -sI https://app.example.com/` and `curl -s https://app.example.com/api/products`.
Mistakes: certificate in the wrong region (CloudFront only sees `us-east-1`), certificate name not matching the origin host name (502), validation CNAMEs never created (cert stays *Pending validation*).

> That gives the exact path from your brief: **Route 53 → CloudFront/React → ALB :443 → ECS → RDS**, with images through S3/CloudFront.
