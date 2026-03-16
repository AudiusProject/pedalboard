# Backfill Audio Analyses

One-shot job that backfills audio analysis data (BPM, musical key) from content nodes into the discovery database. Fetches analyses from content node APIs and updates the `tracks` table. Intended for **prod** only.

## Run locally

From pedalboard repo root:

```bash
turbo run build --filter=@pedalboard/backfill-audio-analyses
node apps/backfill-audio-analyses/dist/index.js
```

Or with env (e.g. `dev.env`):

```bash
audius_discprov_env=dev test_run=true node apps/backfill-audio-analyses/dist/index.js
```

## Environment

- `audius_discprov_env` – network (default `dev`). Job exits unless `prod`.
- `audius_db_url` – discovery DB URL (used by basekit).
- `audius_redis_url` – Redis URL; used for offset and healthy content nodes cache.
- `audius_delegate_private_key` – required; job exits if missing.
- `test_run` – if `true`, run one batch then exit (batch size 100).

## Docker

Built as `audius/pedalboard:backfill-audio-analyses-<tag>` via the monorepo root Dockerfile. Run from repo root:

```bash
./scripts/docker.sh backfill-audio-analyses --tag latest
```
