# Preserving git history for the notifications plugin

The notifications app in this repo was migrated from `apps/packages/discovery-provider/plugins/notifications`. To preserve that folder’s full git history in pedalboard (so `git log apps/notifications` shows the original commits), use the following steps.

## Prerequisites

- **git-filter-repo**  
  Install one of:
  - `pip install git-filter-repo`
  - `brew install git-filter-repo`  
  See: https://github.com/newren/git-filter-repo

## Steps

### 1. Create the filtered apps repo

From the **pedalboard** repo (or anywhere), run:

```bash
./scripts/preserve-notifications-history.sh /path/to/apps-repo
```

Example if apps is a sibling of pedalboard:

```bash
./scripts/preserve-notifications-history.sh ../apps
```

This clones the apps repo to a temporary directory, runs `git filter-repo` to keep only `packages/discovery-provider/plugins/notifications` and renames it to `apps/notifications`, then prints the exact git commands for the next step.

### 2. Merge the filtered history into pedalboard

Run the commands printed by the script. They:

1. Add the filtered repo as a remote and fetch.
2. Create a branch `notifications-with-history`.
3. Remove the current `apps/notifications` and commit (so the merge has a single parent for that path).
4. Merge the filtered repo with `--allow-unrelated-histories` so all past commits that touched the plugin are in pedalboard history.
5. Restore the pedalboard-adapted `apps/notifications` from `main` (package name, tsconfig, Docker image name, etc.) and commit.
6. Merge `notifications-with-history` into `main`.

After that, `git log -- apps/notifications` and `git blame apps/notifications/...` will show the original authors and commits from the apps repo.

### 3. (Optional) Remove the temporary remote and filtered clone

```bash
git remote remove apps-notifications
rm -rf /tmp/apps-notifications-filtered
```

## If you already merged without history

If notifications was added to pedalboard in a single “add notifications” commit and you want to retrofit history:

1. Run the script above to create the filtered repo.
2. Follow the same merge steps on a branch; the “remove apps/notifications” commit plus the merge will attach the old history, and the final “adapt for pedalboard” commit will keep the current file contents.

No need to rewrite existing pedalboard history; the merge brings in the apps history as additional commits.
