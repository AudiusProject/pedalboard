const retiredRewardTypes = new Set([
  'challenge_reward',
  'claimable_reward',
  'reward_in_cooldown',
  'listen_streak_reminder'
])

export const isRetiredRewardNotification = (notification: { type: string }) =>
  retiredRewardTypes.has(notification.type)
