export const config = {
  // Delay (in ms) in sending notifications for unread messages
  dmNotificationDelay: 500,
  // Max age (ms) for DM/reaction push notifications. Notifications older than this are not sent
  // (cursor still advances so we don't reprocess). Prevents flood of old notifications after downtime.
  // 0 = no cap. Default 1 hour.
  dmNotificationMaxAgeMs:
    Number(process.env.DM_NOTIFICATION_MAX_AGE_MS) || 60 * 60 * 1000,
  // ms between jobs
  pollInterval: 500,
  // Batch size of users for chat blast notifications
  blastUserBatchSize: 100,
  // Batch size of notifications to be processed together
  notificationBatchSize: 30,
  // Only process blasts older than this delay (in seconds) to avoid blast vs chat create race condition.
  // See PAY-3573: if a blast rpc and chat create rpc arrive at the same time on different nodes, the blast
  // may not be seeded into the chat if it had not been broadcast to that node yet.
  blastDelay: 30,
  lastIndexedMessageRedisKey: 'latestDMNotificationTimestamp',
  lastIndexedReactionRedisKey: 'latestDMReactionNotificationTimestamp',
  lastIndexedBlastIdRedisKey: 'latestBlastNotificationID',
  lastIndexedBlastUserIdRedisKey: 'latestBlastNotificationUserID'
}
