# Archiver

Creates archive files (ZIP) of track stems for a given entity. Migrated from **apps/packages/discovery-provider/plugins/pedalboard/apps/archiver**.

Uses **@pedalboard/basekit**, **@pedalboard/logger** (createLogger + pino-http), **@pedalboard/storage**, and **@audius/sdk**.

## Run

From repo root (after `npm install` and `turbo run build`):

```bash
npm run build --workspace=@pedalboard/archiver
node apps/archiver/dist/index.js
```

Or from this directory: `npm run build && npm start`.

## Tests

From repo root:

```bash
npm run test --workspace=@pedalboard/archiver
```

Or from this directory: `npm run test` (single run) or `npm run test:watch` (watch mode). Uses Vitest; tests live in `src/workers/spaceManager.test.ts`.

## Env

- `audius_redis_url` – Redis for BullMQ queues (default: `redis://audius-discovery-provider-redis-1:6379/0`)
- `audius_discprov_env` – `dev` | `prod`
- `archiver_server_host` / `archiver_server_port` – HTTP server (default: `0.0.0.0:6004`)
- `archiver_tmp_dir` – Temp directory for archives (default: `/tmp/audius-archiver`)
- `archiver_concurrent_jobs` – Concurrency (default: 5)
- `archiver_cleanup_orphaned_files_interval_seconds` – Cleanup interval (default: 10)
- `archiver_orphaned_jobs_lifetime_seconds` – Job retention (default: 600)
- `archiver_log_level` – Log level (default: `info`)
- `archiver_max_stems_archive_attempts` – Retries (default: 3)
- `archiver_max_disk_space_bytes` – Max disk for archives (default: 32GB)
- `archiver_max_disk_space_wait_seconds` – Wait for space (default: 60)

## Endpoints

- `GET /archive/health_check` – Health check
- `POST /archive/stems/:trackId?user_id=...` – Create stems archive job (headers: `Encoded-Data-Message`, `Encoded-Data-Signature`)
- `GET /archive/stems/job/:jobId` – Job status
- `DELETE /archive/stems/job/:jobId` – Cancel job
- `GET /archive/stems/download/:jobId` – Download ZIP

## Docker

From pedalboard root: `./scripts/docker.sh archiver --tag <tag> [--push]`. Image: `audius/pedalboard:archiver-<tag>`.
