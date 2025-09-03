# Docker Build System

This repository uses a unified Docker build system that works consistently across local development and CI environments.

## Quick Start

### Local Development

Build a specific app:
```bash
./scripts/docker.sh verified-notifications
```

Or use npm scripts:
```bash
npm run docker:verified-notifications
```

### CI/CD

The GitHub Action automatically builds all apps on push to `main`/`develop` or PR to `main`. Each app is built in parallel as a separate job, so failures are isolated.

## Available Commands

### Build Script (`./scripts/docker.sh`)

```bash
./scripts/docker.sh <app_name> [options]

Options:
  --tag TAG         Docker image tag (default: latest)
  --push            Push image after building
  --platform ARCH   Target platform (default: linux/amd64)
  --turbo-team      Turbo team (for remote caching)
  --turbo-token     Turbo token (for remote caching)
  --help            Show help message
```

Examples:
```bash
# Basic build
./scripts/docker.sh verified-notifications
npm run docker:verified-notifications

# Build with custom tag and push
./scripts/docker.sh verified-notifications --tag v1.2.3 --push

# Build for ARM architecture
./scripts/docker.sh verified-notifications --platform linux/arm64

```

### npm scripts

```bash
npm run docker <app-name>          # Build specific app (requires app name argument)
npm run docker:verified-notifications  # Build verified-notifications
npm run docker:crm                 # Build crm
npm run docker:archiver            # Build archiver
# ... (individual scripts for each app)
```

## Available Apps

- `verified-notifications`
- `crm`
- `archiver`
- `staking`
- `trending-challenge-rewards`
- `mri`
- `relay`
- `solana-relay`
- `app-template`
- `anti-abuse-oracle`

## How It Works

### Dockerfile
- Multi-stage build with `base`, `builder`, `installer`, and `runner` stages
- Uses Turbo for efficient monorepo builds with caching
- Supports build-time arguments for app selection and Turbo remote caching

### Build Process
1. **Base stage**: Sets up Node.js environment and build args
2. **Builder stage**: Prunes workspace to only include dependencies for target app
3. **Installer stage**: Installs dependencies and builds the app
4. **Runner stage**: Creates minimal production image

### CI/CD
- Each app builds as a separate GitHub Actions job
- Failures are isolated - one app failing doesn't affect others
- Runs on push to `main`/`develop` and PRs to `main`
- Can be manually triggered via workflow dispatch

## Troubleshooting

### Local Issues

1. **App not found error**:
   ```bash
   ./scripts/docker.sh nonexistent-app
   # Error: App 'nonexistent-app' does not exist
   ```
   Check available apps with `make list-apps`

2. **Docker build fails**:
   - Ensure Docker is running
   - Check if you have sufficient disk space
   - Try building without cache: `docker build --no-cache ...`

3. **Permission denied**:
   ```bash
   chmod +x ./scripts/docker.sh
   ```

### CI Issues

1. **Build timeout**: Increase timeout in GitHub Actions if needed
2. **Out of disk space**: GitHub runners have limited space
3. **Network issues**: Retry the workflow

## Environment Variables

- `TURBO_TEAM`: Turbo remote cache team (optional)
- `TURBO_TOKEN`: Turbo remote cache token (optional)
- `APP_NAME`: Target app name (set automatically by build script)

## Adding New Apps

1. Create app directory in `apps/`
2. Add entry to Makefile (or it will be auto-discovered)
3. Add build job to `.github/workflows/build-apps.yml`