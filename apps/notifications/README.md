# Notifications (Discovery Node)

Service that sends push notifications, indexes DMs for notifications, and sends email (SendGrid). Listens to discovery DB for new notification rows and processes them (push, email, etc.).

## Run locally

```bash
# From pedalboard repo root
turbo run dev --filter=@pedalboard/notifications
# or
cd apps/notifications && npm run dev
```

## Docker

Image is built and pushed as **`audius/notifications:<tag>`** by the pedalboard repo’s Docker build (same name as before migration), so k8s and other consumers can keep using `audius/notifications` with no config change.

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
- `SENDGRID_API_KEY` – email

## sql-ts types

If you need to regenerate types from discovery/identity DB schemas, see [sql-ts](https://github.com/AudiusProject/apps/tree/main/packages/sql-ts) in the apps repo.
