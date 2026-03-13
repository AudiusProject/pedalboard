# Phase 1 cleanup (apps repo)

After the notifications service is running from pedalboard-built images, clean up the apps repo.

## Preserving git history (optional)

To keep the original commit history for `apps/notifications` (from `apps/packages/discovery-provider/plugins/notifications`), see [Preserving git history for the notifications plugin](../../docs/NOTIFICATIONS-HISTORY-PRESERVATION.md). Run that before or after the cleanup below; it only affects the pedalboard repo.

## 1. Remove or archive the plugin

- **Option A:** Delete `apps/packages/discovery-provider/plugins/notifications/` (entire directory).
- **Option B:** Keep the directory but add a README that says: "Source of truth moved to [pedalboard](../pedalboard) repo; this directory is deprecated."

## 2. Update references

- **audius-compose / dev-tools:** If any compose file or script references `discovery-provider-notifications` or the path `packages/discovery-provider/plugins/notifications`, remove or point to **`audius/notifications`** (pedalboard builds this image name; no change needed for k8s).
- **Integration tests:** `apps/packages/discovery-provider/integration_tests/notifications` – either move tests into the pedalboard repo or keep a thin integration test in apps that runs against the deployed notifications service/image.
- **Docs:** Search for "discovery-provider-notifications", "plugins/notifications", or "Discovery Node Notifications Plugin" and update to point at the pedalboard repo.

## 3. Image naming for k8s

- Pedalboard builds and pushes **`audius/notifications:<tag>`** (see `scripts/docker.sh`). The k8s stack (`audius-k8s/notifications`) can keep using `audius/notifications` with no config change.
