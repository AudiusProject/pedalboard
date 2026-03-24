# Verified Notifications

Service that listens to discovery DB `NOTIFY` (tracks, users, usdc_purchases, artist_coins) and posts to Slack for verified uploads, user verification changes, USDC purchases, and artist coin launches.

Source of truth for code and Docker image is this **pedalboard** repo. Production runs on **Kubernetes** via the **audius-k8s** Pulumi stack (`verified-notifications` app; see `Pulumi.prod-verified-notifications.yaml`). Uses **@pedalboard/basekit** (App, `.listen()`, `.task()`, discovery DB) and **@pedalboard/logger**.

## Run

From repo root (after `npm install` and `turbo run build`):

```bash
npm run build --workspace=@pedalboard/verified-notifications
node apps/verified-notifications/dist/index.js
```

Or from this directory: `npm run build && npm start`.

## Env

- `audius_db_url` – discovery DB connection string (required for LISTEN)
- `SLACK_TOKEN` – Slack bot token
- `TRACKS_SLACK_CHANNEL`, `USERS_SLACK_CHANNEL`, `PURCHASES_SLACK_CHANNEL`, `ARTIST_COINS_SLACK_CHANNEL` – channel IDs
- `port` – HTTP server port (default 6000), health at `/health_check`
- `TOGGLE_OFF` – comma-separated topic names to disable (e.g. `tracks,usdc_purchases`)

## Docker

From **pedalboard** repo root:

```bash
npm run docker:verified-notifications
```

Equivalent to `./scripts/docker.sh verified-notifications`. Optional args after `--`, e.g. `npm run docker:verified-notifications -- --tag v1.2.3 --push`. Image: `audius/verified-notifications:<tag>` (default tag `latest`). See root [BUILD.md](../../BUILD.md).
