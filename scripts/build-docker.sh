#!/bin/bash

set -e

APP_NAME=${1:-}
TAG=${2:-latest}

if [ -z "$APP_NAME" ]; then
  echo "Usage: $0 <app_name> [tag]"
  echo "Example: $0 relay latest"
  echo "Available apps: relay, solana-relay, mri, archiver, anti-abuse-oracle, crm, staking, trending-challenge-rewards, verified-notifications"
  exit 1
fi

echo "🏗️  Building Docker image for $APP_NAME with tag $TAG..."

docker build \
  --build-arg app_name="$APP_NAME" \
  -t "pedalboard-$APP_NAME:$TAG" \
  .

echo "✅ Successfully built pedalboard-$APP_NAME:$TAG"