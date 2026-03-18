# Notifications (Discovery Node)

Service that sends push notifications, indexes DMs for notifications, and sends email (SendGrid). Listens to discovery DB for new notification rows and processes them (push, email, etc.).

## Install

Install from the **pedalboard repo root** so workspace deps (`@pedalboard/basekit`, `@pedalboard/logger`) resolve from the monorepo:

```bash
cd /path/to/pedalboard
npm install
```

Do not run `npm install` only inside `apps/notifications` — those packages are not published to npm.

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
- `IDENTITY_DB_POOL_MAX` – (optional) max identity DB pool size; default 30 to avoid connection timeouts under load
- `SENDGRID_API_KEY` – email
- `ANNOUNCEMENT_SEND_SECRET` – (optional) if set, `POST /internal/send-announcement` requires `Authorization: Bearer <this value>` (used by notifications-dashboard)

## sql-ts types

If you need to regenerate types from discovery/identity DB schemas, see [sql-ts](https://github.com/AudiusProject/apps/tree/main/packages/sql-ts) in the apps repo.
