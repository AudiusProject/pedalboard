#!/bin/bash
#
# Preserve git history for the notifications plugin when migrating from the apps repo.
# Run this when you want apps/notifications in pedalboard to keep the commit history
# from apps/packages/discovery-provider/plugins/notifications.
#
# Prerequisites:
#   - git-filter-repo: https://github.com/newren/git-filter-repo
#     pip install git-filter-repo
#     or: brew install git-filter-repo
#
# Usage:
#   ./scripts/preserve-notifications-history.sh [PATH_TO_APPS_REPO] [OUTPUT_DIR]
#
# Then follow the printed instructions to merge the filtered history into pedalboard.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PEDALBOARD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_REPO="${1:-}"
OUTPUT_DIR="${2:-}"

if ! command -v git-filter-repo &>/dev/null; then
  echo "Error: git-filter-repo is required. Install with: pip install git-filter-repo"
  echo "  See https://github.com/newren/git-filter-repo"
  exit 1
fi

if [[ -z "$APPS_REPO" ]]; then
  echo "Usage: $0 PATH_TO_APPS_REPO [OUTPUT_DIR]"
  echo ""
  echo "  PATH_TO_APPS_REPO  Path to the apps repo (Audius apps monorepo)"
  echo "  OUTPUT_DIR         Where to write the filtered repo (default: /tmp/apps-notifications-filtered)"
  echo ""
  echo "Example:"
  echo "  $0 ../apps"
  echo "  $0 /path/to/audius-apps /tmp/notifications-history"
  exit 1
fi

APPS_REPO="$(cd "$APPS_REPO" && pwd)"
FILTERED_DIR="${OUTPUT_DIR:-/tmp/apps-notifications-filtered}"

if [[ ! -d "$APPS_REPO/.git" ]]; then
  echo "Error: Not a git repo: $APPS_REPO"
  exit 1
fi

if [[ -d "$FILTERED_DIR" ]]; then
  echo "Error: Output dir already exists (remove it first): $FILTERED_DIR"
  exit 1
fi

echo "Cloning apps repo to $FILTERED_DIR (bare clone for filter-repo)..."
git clone --no-checkout "$APPS_REPO" "$FILTERED_DIR"
cd "$FILTERED_DIR"

echo "Running git-filter-repo: keep only notifications plugin, rename to apps/notifications..."
git filter-repo \
  --path packages/discovery-provider/plugins/notifications \
  --path-rename 'packages/discovery-provider/plugins/notifications':apps/notifications \
  --force

echo ""
echo "=============================================="
echo "Filtered repo created at: $FILTERED_DIR"
echo "=============================================="
echo ""
echo "Next, run these commands from the PEDALBOARD repo ($PEDALBOARD_ROOT):"
echo ""
echo "  cd $PEDALBOARD_ROOT"
echo "  git remote add apps-notifications $FILTERED_DIR"
echo "  git fetch apps-notifications"
echo ""
echo "  # Create a branch to merge history (replace main with your default branch if needed)"
echo "  git checkout -b notifications-with-history"
echo ""
echo "  # Remove current apps/notifications so the merge brings in history"
echo "  git rm -rf apps/notifications"
echo "  git commit -m \"chore(notifications): remove to merge history from apps repo\""
echo ""
echo "  # Merge the filtered history (default branch may be main or master)"
echo "  git merge apps-notifications/main --allow-unrelated-histories -m \"Merge notifications plugin history from apps repo\""
echo "  # If the default branch is master: git merge apps-notifications/master ..."
echo ""
echo "  # Restore pedalboard-adapted files (package.json, tsconfig, etc.) from current main"
echo "  git checkout main -- apps/notifications"
echo "  git add apps/notifications"
echo "  git commit -m \"chore(notifications): adapt for pedalboard (package name, tsconfig, image audius/notifications)\""
echo ""
echo "  # Merge into main"
echo "  git checkout main"
echo "  git merge notifications-with-history -m \"Merge notifications with preserved history from apps\""
echo ""
echo "  # Optional: remove the temporary remote"
echo "  git remote remove apps-notifications"
echo ""
