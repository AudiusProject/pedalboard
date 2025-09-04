#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
    echo "Usage: $0 <app_name> [options]"
    echo ""
    echo "Arguments:"
    echo "  app_name          Name of the app to build (e.g., verified-notifications)"
    echo ""
    echo "Options:"
    echo "  --tag TAG         Docker image tag (default: latest)"
    echo "  --push            Push image after building"
    echo "  --platform ARCH   Target platform (default: linux/amd64)"
    echo "  --turbo-team      Turbo team (for remote caching)"
    echo "  --turbo-token     Turbo token (for remote caching)"
    echo ""
    echo "  --help            Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 verified-notifications"
    echo "  $0 verified-notifications --tag v1.2.3 --push"
    echo "  $0 verified-notifications --platform linux/arm64"
    exit 1
}

# Default values
APP_NAME=""
TAG="latest"
PUSH=false
# Default to multi-platform build for both architectures
PLATFORM="linux/amd64,linux/arm64"
TURBO_TEAM=""
TURBO_TOKEN=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --tag)
            TAG="$2"
            shift 2
            ;;
        --push)
            PUSH=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --turbo-team)
            TURBO_TEAM="$2"
            shift 2
            ;;
        --turbo-token)
            TURBO_TOKEN="$2"
            shift 2
            ;;
        --help)
            usage
            ;;
        -*)
            echo "Unknown option $1"
            usage
            ;;
        *)
            if [[ -z "$APP_NAME" ]]; then
                APP_NAME="$1"
            else
                echo "Too many arguments"
                usage
            fi
            shift
            ;;
    esac
done

# Validate required arguments
if [[ -z "$APP_NAME" ]]; then
    echo "Error: app_name is required"
    usage
fi

# Validate app exists
if [[ ! -d "$PROJECT_ROOT/apps/$APP_NAME" ]]; then
    echo "Error: App '$APP_NAME' does not exist in apps/ directory"
    echo "Available apps:"
    ls -1 "$PROJECT_ROOT/apps" | sed 's/^/  /'
    exit 1
fi

# Build docker command
IMAGE_NAME="audius/pedalboard:${APP_NAME}-${TAG}"

# Use buildx for multi-platform builds
DOCKER_ARGS=(
    "buildx" "build"
    "--platform" "$PLATFORM"
    "--build-arg" "app_name=$APP_NAME"
    "--tag" "$IMAGE_NAME"
)

# Add Turbo cache args if provided
if [[ -n "$TURBO_TEAM" ]]; then
    DOCKER_ARGS+=("--build-arg" "TURBO_TEAM=$TURBO_TEAM")
fi

if [[ -n "$TURBO_TOKEN" ]]; then
    DOCKER_ARGS+=("--build-arg" "TURBO_TOKEN=$TURBO_TOKEN")
fi

# Add context
DOCKER_ARGS+=("$PROJECT_ROOT")

echo "Building Docker image for app: $APP_NAME"
echo "Image name: $IMAGE_NAME"
echo "Platform: $PLATFORM"

# For multi-platform builds with push, add --push to buildx command
if [[ "$PUSH" == "true" ]] && [[ "$PLATFORM" == *","* ]]; then
    DOCKER_ARGS+=("--push")
fi

# Execute docker build
echo ""
echo "Executing: docker ${DOCKER_ARGS[*]}"
docker "${DOCKER_ARGS[@]}"

# For single-platform builds, push separately
if [[ "$PUSH" == "true" ]] && [[ "$PLATFORM" != *","* ]]; then
    echo ""
    echo "Pushing image: $IMAGE_NAME"
    docker push "$IMAGE_NAME"
fi

echo ""
echo "✅ Build completed successfully!"
echo "Image: $IMAGE_NAME"