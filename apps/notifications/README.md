# Notifications (Discovery Node)

Service that sends push notifications, indexes DMs for notifications, and sends email (SendGrid). Listens to discovery DB for new notification rows and processes them (push, email, etc.).

## Install

Install from the **pedalboard repo root** so workspace deps (`@pedalboard/basekit`, `@pedalboard/logger`) resolve from the monorepo:

```bash
cd /path/to/pedalboard
npm install
```

Do not run `npm install` only inside `apps/notifications` — those packages are not published to npm.

## Tests

### Via apps (audius-compose) — easiest if you use protocol Docker

From the **Audius `apps` monorepo** (where `dev-tools/audius-compose` lives), with **pedalboard** checked out next to it by default (`../pedalboard`):

```bash
cd /path/to/apps
./dev-tools/audius-compose test run notifications
```

Optional: `export PEDALBOARD_ROOT=/absolute/path/to/pedalboard` if your clone is not at `apps/../pedalboard`.

This builds a small test image (Python + `make`/`g++` for optional native deps like `bufferutil`) and starts `test-notifications` (see `dev-tools/compose/docker-compose.test.yml` and `Dockerfile.notifications-test`): migrations + Postgres + Redis from the test stack, then `npm ci` at pedalboard root and `npm test` in `apps/notifications`.

Email HTML snapshots use a fixed footer year in Jest (`NOTIFICATIONS_EMAIL_COPYRIGHT_YEAR`, set in `src/__tests__/jest.setup-env.js`) so they don’t need yearly updates. Production still uses the real calendar year.

### Locally (Postgres + Redis already running)

You need **template** DBs (last path segment of each URL is cloned per test):

```bash
export DN_DB_URL='postgresql://USER:PASS@HOST:PORT/discovery_provider'
export IDENTITY_DB_URL='postgresql://USER:PASS@HOST:PORT/identity_service'
# optional if not redis://localhost:6379/0
# export AUDIUS_REDIS_URL='redis://...'

cd /path/to/pedalboard
npm install
npm run test:notifications
# or: cd apps/notifications && npm test
```

## Run locally

```bash
# From pedalboard repo root
turbo run dev --filter=@pedalboard/notifications
# or
cd apps/notifications && npm run dev
```

## Docker

Same publish flow as other apps: from **repo root** use the shared script. Image is tagged **`audius/notifications:<tag>`** (legacy name for k8s):

```bash
# Build only
./scripts/docker.sh notifications --tag latest

# Build and push
./scripts/docker.sh notifications --tag latest --push
```

## Test push (SNS)

```bash
npx ts-node scripts/test-push-notification.ts
```

To find `targetARN`: query identity DB table `NotificationDeviceTokens`, e.g. `select * from "NotificationDeviceTokens" where "userId"=<YOUR_USER_ID>;`

## Environment variables

- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` – push (SNS)
- `DN_DB_URL` – discovery DB
- `AUDIUS_REDIS_URL` – Redis (cursors, retry queue)
- `IDENTITY_DB_URL` – identity DB
- `DISCOVERY_DB_POOL_MAX` – (optional) max discovery Knex pool; default **25** (`LISTEN` uses one connection from this pool)
- `IDENTITY_DB_POOL_MAX` – (optional) max identity Knex pool; default **50**
- `DM_PUSH_CONCURRENCY` – (optional) max parallel DM/reaction push handlers per tick; default **4**
- `DM_NOTIFICATION_MAX_AGE_MS` – (optional) skip DM/reaction pushes older than this (ms); default 1h; **0** = no cap
- `NOTIFICATION_RETRY_BATCH_MAX` – (optional) max Redis retry-queue entries LPOP’d per tick; default **150**
- `DISCOVERY_LISTEN_RECONNECT_MS` – (optional) basekit `LISTEN` reconnect backoff; see `@pedalboard/basekit`
- `OPTIMIZELY_SDK_KEY` – (optional) Optimizely Full Stack SDK key; if unset, a built-in fallback key is used
- `NOTIFICATIONS_LOG_REMOTE_CONFIG_SNAPSHOT` – set to **`1`** to log a one-shot **`Remote config snapshot (Optimizely)`** at startup (all push flags + raw vs effective)
- `GIT_COMMIT`, `IMAGE_TAG`, `BUILD_TIME` – (optional) deploy metadata for logs and `/health_check`; see Dockerfile build-args
- `SENDGRID_API_KEY` – email
- `ANNOUNCEMENT_SEND_SECRET` – (optional) if set, `POST /internal/send-announcement` requires `Authorization: Bearer <this value>` (used by notifications-dashboard). Optional body field **`notification_campaign_id`** is stored on the notification row and included on mobile push payloads.

### Push pipeline logs

- **`Processing N push notifications`** / **`Done processing push notifications (processed=… skipped=… errored=…)`** – includes structured **`pushOutcome`**

## sql-ts types

If you need to regenerate types from discovery/identity DB schemas, see [sql-ts](https://github.com/AudiusProject/apps/tree/main/packages/sql-ts) in the apps repo.
