# 01 — Run it locally first

Never debug AWS and your code at the same time. Get the app working on your laptop, then the only new variable in the
cloud is *AWS*.

```
Browser :5173 ──► Vite dev server ──/api──► Node API (Docker) :3000 ──► MySQL (Docker) :3306
                       └──/images──► ../assets/images   (stands in for S3)
```

## 1. Start MySQL + the API

```bash
docker compose up -d --build
docker compose run --rm api npm run db:init
```

Expected output of the second command (one JSON log line per event):

```
{"time":"2026-10-02T12:00:01.210Z","level":"info","msg":"db_seeded"}
```

## 2. Test the API

```bash
curl -s localhost:3000/health
curl -s localhost:3000/health/ready
curl -s localhost:3000/api/products | head -c 400
```

```json
{"status":"ok"}
{"status":"ready","db":"up"}
{"products":[{"id":1,"name":"Wireless Headphones","description":"Over-ear Bluetooth ...","price":129.99,"imageUrl":"/images/headphones.svg"}, ...
```

Notice `imageUrl`: the database stores only the **S3 key** (`images/headphones.svg`); the API turns it into a URL using
`IMAGE_BASE_URL` (empty → same-origin `/images/...`).

## 3. Run the React app

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

You should see five product cards with images. Stop the API (`docker compose stop api`) and reload: the page shows the
error state with a **Try again** button — that is the behaviour you will also see if the AWS side breaks.

## 4. See the logs the way CloudWatch will

```bash
docker compose logs -f api
```

Every `console.log` line goes to **stdout**. In ECS the `awslogs` driver ships exactly this stream to CloudWatch. That is
the whole trick (chapter 08).

## Configuration reference (environment variables)

| Variable | Local | In AWS | Meaning |
|----------|-------|--------|---------|
| `PORT` | 3000 | 3000 | listen port |
| `DB_HOST` / `DB_PORT` / `DB_NAME` | `db` / 3306 / `productsdb` | RDS endpoint / 3306 / `productsdb` | where MySQL is |
| `DB_USER` + `DB_PASSWORD` | `root` + dev password | **not set** | local-only credentials |
| `DB_SECRET_ARN` | not set | ARN of the Secrets Manager secret | AWS credentials source |
| `DB_SSL` | `false` | `true` | encrypt + verify the DB connection |
| `DB_POOL_SIZE` | 10 | 10 | max connections **per container** |
| `IMAGE_BASE_URL` | empty | empty (CloudFront same-origin) | prefix for image keys |
| `CORS_ORIGIN` | unset | unset | only if the browser calls the API cross-origin |

> **Connection-pool sizing.** Pool size × number of tasks must stay below MySQL's `max_connections`.
> A `db.t3.micro` (1 GB RAM) allows roughly 60–70. 2 tasks × 10 = 20 — comfortable.

## Clean up

```bash
docker compose down        # add -v to also delete the MySQL data volume
```

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Cannot connect to the Docker daemon` | Start Docker Desktop and wait until it says *running* |
| `ECONNREFUSED ... :3306` | MySQL not healthy yet: `docker compose ps`, wait for `healthy` |
| `Unknown database 'productsdb'` | Volume from an older run: `docker compose down -v` and start again |
| Page loads, no images | `assets/images` missing, or you built with `npm run build` (images are only served by the dev server) |
