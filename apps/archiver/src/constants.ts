export const MESSAGE_HEADER = 'Encoded-Data-Message'
export const SIGNATURE_HEADER = 'Encoded-Data-Signature'
export const STEMS_ARCHIVE_QUEUE_NAME = 'stems-archive'
export const CLEANUP_ORPHANED_FILES_QUEUE_NAME = 'cleanup-orphaned-files'

// Archive content node — guaranteed to host every file uploaded to the network.
// Used as the final fallback when none of the mirrors listed on the upload are
// reachable, so a single mirror outage doesn't kill an archive job.
export const ARCHIVE_FALLBACK_HOST = 'https://creatornode2.audius.co'

// Per-mirror download timeout. A hung node otherwise blocks the whole job —
// node-fetch has no default timeout, so without this we'd wait indefinitely.
export const MIRROR_DOWNLOAD_TIMEOUT_MS = 30_000
