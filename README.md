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

# Tools

Turborepo

Docker

Typescript

Npm
