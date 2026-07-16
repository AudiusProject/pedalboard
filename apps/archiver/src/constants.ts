export const MESSAGE_HEADER = 'Encoded-Data-Message'
export const SIGNATURE_HEADER = 'Encoded-Data-Signature'
export const STEMS_ARCHIVE_QUEUE_NAME = 'stems-archive'
export const CLEANUP_ORPHANED_FILES_QUEUE_NAME = 'cleanup-orphaned-files'

// Archive content node — used as the final fallback when neither the
// canonical redirect host nor any mirror can serve the file, so a single node
// outage doesn't kill an archive job. creatornode2.audius.co was
// decommissioned (bare nginx 404s everything, 2026-07-16 stems incident);
// creatornode.audius.co is the node that ingests/transcodes uploads and
// peer-redirects for blobs it doesn't hold locally.
export const ARCHIVE_FALLBACK_HOST = 'https://creatornode.audius.co'

// Per-mirror download timeout. A hung node otherwise blocks the whole job —
// node-fetch has no default timeout, so without this we'd wait indefinitely.
export const MIRROR_DOWNLOAD_TIMEOUT_MS = 30_000
