# Pedalboard

Pedalboard is a collection of packages and plugins meant to run alongside a discovery indexer and database. They're meant to operate in isolation but stack together to expose various combinations of functionality to the network.

```
npm install turbo --global
npm install
```

# Project Structure

There are two main directories where work is done. [Packages](./packages) and [Apps](./apps). Packages are modules and libraries that are useful across various plugins. Apps are code that gets compiled and run against the database and indexer.

# Starting a new application

To create a new application copy and paste the [app-template](./apps/app-template/). Rename your directory and package json project name to what you'd like and you should be ready to start developing. The application template will have an example app for you to get started with.

At this time of writing this is what it looks like:

```
import { log } from "@pedalboard/logger";
import App from "@pedalboard/basekit/src/app";
import moment from "moment";

type SharedData = {};

const main = async () => {
  await new App<SharedData>({})
    .tick({ seconds: 5 }, async (_app) => {
      console.log(`tick ${moment().calendar()}`)
    })
    .run();
};

(async () => {
  await main().catch(log);
})();
```

# Starting a new package

1. Copy the app template

```
cp ./apps/app-template ./apps/my-app
```

2. Modify `package.json` to have your app name

3. Install dependencies from the monorepo root
4. 
```
npm i
```

# Development with Turborepo

This monorepo uses [Turborepo](https://turbo.build) for fast, efficient development. Turborepo provides caching, parallel execution, and dependency management.

## Running Applications

**Run a single app for development (with hot reload):**
```bash
turbo run dev --filter=@pedalboard/app-template
turbo run dev --filter=@pedalboard/relay
```

**Run with dependencies (builds packages first):**
```bash
turbo run dev --filter=@pedalboard/app-template...
```

**Run multiple apps:**
```bash
turbo run dev --filter=@pedalboard/relay --filter=@pedalboard/staking
```

## Building

**Build everything:**
```bash
turbo run build
```

**Build specific packages:**
```bash
turbo run build --filter=@pedalboard/logger
```

**Build with concurrency:**
```bash
turbo run build --concurrency=4
```

## Testing the apps

**One-time setup (from repo root):**
```bash
npm install
turbo run build
```

Then test each app as follows. Use a `.env` in the app directory or export vars in your shell; see each app’s README for required env.

### Notifications

Needs: discovery DB, identity DB, Redis; optional AWS/SendGrid for push/email.

```bash
# Option A: dev with hot reload
turbo run dev --filter=@pedalboard/notifications

# Option B: build then run
turbo run build --filter=@pedalboard/notifications
node apps/notifications/dist/main.js
```

**Success:** Process stays running, logs “processing events” and “LISTENER Started”. Hit `http://localhost:6000/health_check` for a JSON health response.

Set `DN_DB_URL`, `IDENTITY_DB_URL`, `AUDIUS_REDIS_URL` (and optionally AWS/SendGrid) in env or `apps/notifications/.env`.

### Backfill-audio-analyses

One-shot job. Needs: discovery DB, Redis, delegate private key. Exits unless `audius_discprov_env=prod` (or use `test_run=true` for one batch on any env).

```bash
turbo run build --filter=@pedalboard/backfill-audio-analyses
# With test_run so it does one batch and exits (no prod required)
audius_db_url=<DISCOVERY_DB> audius_redis_url=<REDIS_URL> audius_delegate_private_key=<KEY> \
  test_run=true audius_discprov_env=dev node apps/backfill-audio-analyses/dist/index.js
```

**Success:** Logs “running on dev network”, batch progress, then “backfill_discovery.ts | No more tracks to backfill. Goodbye!” (or “[TEST RUN] Saved audio analyses…” and exit).

### SLA Auditor

Needs: discovery DB, Ethereum RPC, delegate wallet/key, and chain contract env. Use `dryRun=true` to avoid submitting real governance proposals.

```bash
turbo run build --filter=@pedalboard/sla-auditor
# Dry run: only logs what it would do
dryRun=true audius_db_url=<DISCOVERY_DB> audius_web3_eth_provider_url=<RPC> \
  audius_delegate_owner_wallet=<WALLET> audius_delegate_private_key=<KEY> \
  audius_eth_token_address=<ADDR> audius_eth_contracts_registry=<REGISTRY> \
  node apps/sla-auditor/dist/index.js
```

**Success:** Process stays running, logs “Dry run: true”, creates table if needed, then every 10 minutes logs “[PASS]” or “[FAILED]” per node and “=======DRY RUN=======” when it would propose.

### Publish scheduled releases

Needs: discovery DB only. Every minute, lists eligible scheduled tracks/albums and publishes them; creates fan remix contest notifications when applicable. Run a **single** replica if you want to avoid overlapping publishers during deploys.

```bash
turbo run build --filter=@pedalboard/publish-scheduled-releases
audius_db_url=<DISCOVERY_DB> node apps/publish-scheduled-releases/dist/index.js
```

**Success:** Process stays running; `http://localhost:6000/health_check` returns JSON. Logs when tracks/albums are published.

### Unit tests

```bash
turbo run test
# Or for one app (e.g. notifications)
npm run test --workspace=@pedalboard/notifications
```

Notifications has Jest tests (may require `DN_DB_URL` / `IDENTITY_DB_URL` for integration tests).

## Other Commands

**Lint all packages:**
```bash
turbo run lint
```

**Run tests:**
```bash
turbo run test
```

**Clean build artifacts:**
```bash
turbo run clean
```

# Syncing from audius-protocol

This repository was extracted from the main [audius-protocol](https://github.com/AudiusProject/audius-protocol) repository. To sync new changes from the main repo:

## Setup (one-time)

Add the main audius-protocol repo as a remote:
```bash
git remote add ap https://github.com/AudiusProject/audius-protocol.git
git fetch ap
```

## Syncing Changes

1. **Find pedalboard-related commits in the main repo:**
```bash
git log ap/main --oneline -- "*pedalboard*" "*/pedalboard/*"
```

2. **Cherry-pick specific commits:**
```bash
git cherry-pick <commit-hash>
```

3. **Test your changes:**
```bash
turbo run build
turbo run dev --filter=@pedalboard/app-template
```

4. **Handle conflicts if they occur:**
```bash
# Fix conflicts manually, then:
git add .
git cherry-pick --continue
```

**Example workflow:**
```bash
# Fetch latest from main repo
git fetch ap

# Look for recent pedalboard changes
git log ap/main --oneline -20 -- "*pedalboard*"

# Cherry-pick a specific commit
git cherry-pick abc1234

# Test the changes
turbo run build --filter=@pedalboard/relay
```

# Notifications plugin and git history

The **notifications** app was migrated from the apps repo (`packages/discovery-provider/plugins/notifications`). To preserve that path’s git history in this repo, see [docs/NOTIFICATIONS-HISTORY-PRESERVATION.md](docs/NOTIFICATIONS-HISTORY-PRESERVATION.md) and run `./scripts/preserve-notifications-history.sh ../apps` (or your path to the apps repo).

# Tools

Turborepo

Docker

Typescript

Npm
