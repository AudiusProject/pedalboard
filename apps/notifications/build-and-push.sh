#!/bin/bash

# Script to build and push the notifications Docker image.
# Uses the monorepo root Dockerfile so workspace deps (@pedalboard/basekit, etc.) are included.
#
# Usage: ./build-and-push.sh [version]
# Example: ./build-and-push.sh v1.0.0
# If no version is provided, it will use 'latest'
#
# Note: This script builds for linux/amd64 platform to ensure compatibility
# with Kubernetes clusters running on x86_64 architecture.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PEDALBOARD_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

IMAGE_NAME="audius/notifications"
VERSION="${1:-latest}"

echo -e "${GREEN}Building Docker image: ${IMAGE_NAME}:${VERSION}${NC}"
echo -e "${YELLOW}Platform: linux/amd64 (for Kubernetes compatibility)${NC}"
echo -e "${YELLOW}Using monorepo root Dockerfile (includes @pedalboard/basekit, etc.)${NC}"

# Ensure buildx is available and create a builder if needed
docker buildx create --use --name multiarch-builder 2>/dev/null || docker buildx use multiarch-builder

# Build from monorepo root so workspace deps resolve (turbo prune includes them)
cd "$PEDALBOARD_ROOT"
docker buildx build \
  --platform linux/amd64 \
  -f Dockerfile \
  --build-arg app_name=notifications \
  -t "${IMAGE_NAME}:${VERSION}" \
  --load \
  .

if [ "$VERSION" != "latest" ]; then
  docker tag "${IMAGE_NAME}:${VERSION}" "${IMAGE_NAME}:latest"
fi

echo -e "${GREEN}Build complete!${NC}"
echo ""
echo -e "${YELLOW}To push the image to Docker Hub:${NC}"
echo "  1. Login to Docker Hub: ${GREEN}docker login${NC}"
echo "  2. Push the image: ${GREEN}docker push ${IMAGE_NAME}:${VERSION}${NC}"
if [ "$VERSION" != "latest" ]; then
  echo "  3. Push latest tag: ${GREEN}docker push ${IMAGE_NAME}:latest${NC}"
fi
echo ""
read -p "Do you want to push the image now? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo -e "${GREEN}Pushing ${IMAGE_NAME}:${VERSION}...${NC}"
  docker push "${IMAGE_NAME}:${VERSION}"

  if [ "$VERSION" != "latest" ]; then
    echo -e "${GREEN}Pushing ${IMAGE_NAME}:latest...${NC}"
    docker push "${IMAGE_NAME}:latest"
  fi

  echo -e "${GREEN}Push complete!${NC}"
fi
