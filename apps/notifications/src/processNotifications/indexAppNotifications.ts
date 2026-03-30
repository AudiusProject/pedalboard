import { Knex } from 'knex'

import { logger } from '../logger'
import { mapNotifications } from '../processNotifications/mappers/mapNotifications'
import { NotificationRow } from '../types/dn'
import { Follow } from './mappers/follow'
import { Repost } from './mappers/repost'
import { RepostOfRepost } from './mappers/repostOfRepost'
import { SaveOfRepost } from './mappers/saveOfRepost'
import { Save } from './mappers/save'
import { Remix } from './mappers/remix'
import { CosignRemix } from './mappers/cosign'
import { SupporterRankUp } from './mappers/supporterRankUp'
import { SupportingRankUp } from './mappers/supportingRankUp'
import { Tastemaker } from './mappers/tastemaker'
import { TierChange } from './mappers/tierChange'
import { TipReceive } from './mappers/tipReceive'
import { TipSend } from './mappers/tipSend'
import { Milestone } from './mappers/milestone'
import { Comment } from './mappers/comment'
import {
  BrowserPluginMappings,
  BrowserPushPlugin,
  EmailPluginMappings,
  MappingFeatureName,
  MappingVariable,
  NotificationsEmailPlugin,
  RemoteConfig
} from '../remoteConfig'
import { config } from '../config'
import { Timer } from '../utils/timer'
import { getRedisConnection } from '../utils/redisConnection'
import { RequiresRetry } from '../types/notifications'
import { CommentThread } from './mappers/commentThread'
import { CommentMention } from './mappers/commentMention'
import { CommentReaction } from './mappers/commentReaction'

const NOTIFICATION_RETRY_QUEUE_REDIS_KEY = 'notification_retry'

export type ProcessNotificationsOptions = {
  /**
   * Items were LPOP'd from the retry queue. On skip or non-retry error, push
   * back so we match old "stays on the list" behavior; successes stay popped.
   */
  requeuePoppedRetries?: boolean
}

export type NotificationProcessor =
  | Follow
  | Repost
  | Save
  | Remix
  | CosignRemix
  | Milestone
  | RepostOfRepost
  | SaveOfRepost
  | SupporterRankUp
  | SupportingRankUp
  | Tastemaker
  | TierChange
  | TipReceive
  | TipSend
  | Comment
  | CommentThread
  | CommentMention
  | CommentReaction

export const notificationTypeMapping = {
  follow: MappingVariable.PushFollow,
  repost: MappingVariable.PushRepost,
  save: MappingVariable.PushSave,
  save_of_repost: MappingVariable.PushSaveOfRepost,
  repost_of_repost: MappingVariable.PushRepostOfRepost,
  milestone: MappingVariable.PushMilestone,
  milestone_follower_count: MappingVariable.PushMilestone,
  remix: MappingVariable.PushRemix,
  cosign: MappingVariable.PushCosign,
  supporter_rank_up: MappingVariable.PushSupporterRankUp,
  supporting_rank_up: MappingVariable.PushSupportingRankUp,
  supporter_dethroned: MappingVariable.PushSupporterDethroned,
  tip_receive: MappingVariable.PushTipRceive,
  tip_send: MappingVariable.PushTipSend,
  challenge_reward: MappingVariable.PushChallengeReward,
  claimable_reward: MappingVariable.PushClaimableReward,
  track_added_to_playlist: MappingVariable.PushTrackAddedToPlaylist,
  create: MappingVariable.PushCreate,
  trending: MappingVariable.PushTrending,
  trending_underground: MappingVariable.PushTrendingUnderground,
  tastemaker: MappingVariable.PushTastemaker,
  usdc_purchase_seller: MappingVariable.PushUSDCPurchaseSeller,
  usdc_purchase_buyer: MappingVariable.PushUSDCPurchaseBuyer,
  usdc_transfer: MappingVariable.PushUSDCTransfer,
  usdc_withdrawal: MappingVariable.PushUSDCWithdrawal,
  request_manager: MappingVariable.PushRequestManager,
  approve_manager_request: MappingVariable.PushApproveManagerRequest,
  announcement: MappingVariable.PushAnnouncement,
  reaction: MappingVariable.PushReaction,
  reward_in_cooldown: MappingVariable.PushRewardInCooldown,
  comment: MappingVariable.PushComment,
  comment_thread: MappingVariable.PushCommentThread,
  comment_mention: MappingVariable.PushCommentMention,
  comment_reaction: MappingVariable.PushCommentReaction,
  listen_streak_reminder: MappingVariable.PushListenStreakReminder,
  artist_remix_contest_ended: MappingVariable.PushArtistRemixContestEnded,
  fan_remix_contest_ended: MappingVariable.PushFanRemixContestEnded,
  fan_remix_contest_ending_soon: MappingVariable.PushFanRemixContestEndingSoon,
  fan_remix_contest_started: MappingVariable.PushFanRemixContestStarted,
  fan_remix_contest_winners_selected:
    MappingVariable.PushFanRemixContestWinnersSelected,
  artist_remix_contest_ending_soon:
    MappingVariable.PushArtistRemixContestEndingSoon,
  artist_remix_contest_submissions:
    MappingVariable.PushArtistRemixContestSubmissions
}

export class AppNotificationsProcessor {
  dnDB: Knex
  identityDB: Knex
  remoteConfig: RemoteConfig

  constructor(dnDB: Knex, identityDB: Knex, remoteConfig: RemoteConfig) {
    this.dnDB = dnDB
    this.identityDB = identityDB
    this.remoteConfig = remoteConfig
  }

  getIsPushNotificationEnabled(type: string) {
    const mappingVariable = notificationTypeMapping[type]
    // If there is no remote variable, do no push - it must be explicitly enabled
    if (!mappingVariable) return false
    const featureEnabled = this.remoteConfig.getFeatureVariableEnabled(
      MappingFeatureName,
      mappingVariable
    )
    // If the feature does not exist in remote config, then it returns null
    // In that case, set to false bc we want to explicitly set to true
    return Boolean(featureEnabled)
  }

  getIsLiveEmailEnabled() {
    const isEnabled = this.remoteConfig.getFeatureVariableEnabled(
      NotificationsEmailPlugin,
      EmailPluginMappings.Live
    )
    // If the feature does not exist in remote config, then it returns null
    // In that case, set to false bc we want to explicitly set to true
    return Boolean(isEnabled)
  }

  getIsBrowserPushEnabled(): boolean {
    const isEnabled = this.remoteConfig.getFeatureVariableEnabled(
      BrowserPushPlugin,
      BrowserPluginMappings.Enabled
    )
    return Boolean(isEnabled)
  }

  /**
   * Processes an array of notification rows, delivering them incrementally.
   */
  async process(
    notifications: NotificationRow[],
    options?: ProcessNotificationsOptions
  ) {
    if (notifications.length == 0) return

    logger.info(
      {
        count: notifications.length,
        types: notifications.map((n) => n.type),
        ids: notifications.map((n) => n.id)
      },
      `Processing ${notifications.length} push notifications`
    )

    const redis = await getRedisConnection()

    const timer = new Timer('Processing notifications duration')
    const blocknumber = notifications[0].blocknumber
    let blockhash: unknown
    try {
      blockhash = await this.dnDB
        .select('blockhash')
        .from('blocks')
        .where('number', blocknumber)
        .first()
    } catch (e) {
      logger.warn(
        { err: e, blocknumber },
        'process: failed to fetch blockhash, continuing'
      )
    }
    const status = {
      total: notifications.length,
      processed: 0,
      errored: 0,
      skipped: 0,
      needsRetry: 0,
      blocknumber,
      blockhash
    }

    // Filter out notifications triggered by shadowbanned users
    try {
      const usersTriggeringNotifications = notifications
        .filter((notification) =>
          ['follow', 'repost', 'save'].includes(notification.type)
        )
        .map((notification) => Number(notification.specifier))

      if (usersTriggeringNotifications.length > 0) {
        const res = await this.dnDB.raw(
          `
            SELECT *
            FROM get_user_scores(?)
            WHERE score <= 0
            `,
          [usersTriggeringNotifications]
        )

        const shadowBannedUsers = res.rows.map((row) => String(row.user_id))
        logger.info(
          `Skipping notifications triggered by users: ${shadowBannedUsers}`
        )

        notifications = notifications.filter(
          (notification) => !shadowBannedUsers.includes(notification.specifier)
        )
      }
    } catch (error) {
      logger.error('Error shadow banning users:', error)
    }

    status.total = notifications.length

    const mappedNotifications = mapNotifications(
      notifications,
      this.dnDB,
      this.identityDB
    )

    for (const notification of mappedNotifications) {
      const isEnabled = this.getIsPushNotificationEnabled(
        notification.notification.type
      )
      if (isEnabled) {
        const isLiveEmailEnabled = this.getIsLiveEmailEnabled()
        const isBrowserPushEnabled = this.getIsBrowserPushEnabled()
        try {
          await notification.processNotification({
            isLiveEmailEnabled,
            isBrowserPushEnabled,
            // Must bind: passing `this.getIsPushNotificationEnabled` drops the
            // receiver and breaks `this.remoteConfig` inside the processor.
            getIsPushNotificationEnabled: (type: string) =>
              this.getIsPushNotificationEnabled(type)
          })
          status.processed += 1
        } catch (e) {
          if (e instanceof RequiresRetry) {
            status.needsRetry += 1
            // enqueue in redis
            await redis.lPush(
              NOTIFICATION_RETRY_QUEUE_REDIS_KEY,
              JSON.stringify(notification.notification)
            )
          } else {
            logger.error(
              {
                type: notification.notification.type,
                message: e.message
              },
              `Error processing push notification`
            )
            status.errored += 1
            if (options?.requeuePoppedRetries) {
              await redis.lPush(
                NOTIFICATION_RETRY_QUEUE_REDIS_KEY,
                JSON.stringify(notification.notification)
              )
            }
          }
        }
      } else {
        status.skipped += 1
        logger.info(
          `Skipping push notification of type ${notification.notification.type}`
        )
        if (options?.requeuePoppedRetries) {
          await redis.lPush(
            NOTIFICATION_RETRY_QUEUE_REDIS_KEY,
            JSON.stringify(notification.notification)
          )
        }
      }
    }

    logger.info(
      {
        ...timer.getContext(),
        ...status,
        pushOutcome: {
          total: status.total,
          processed: status.processed,
          skipped: status.skipped,
          errored: status.errored,
          needsRetry: status.needsRetry
        }
      },
      `Done processing push notifications (processed=${status.processed} skipped=${status.skipped} errored=${status.errored} needsRetry=${status.needsRetry} total=${status.total})`
    )
  }

  /**
   * Reprocesses notifications from the Redis retry queue (USDC-gated create, etc.).
   * LPOPs a bounded batch per tick so we do not re-run the entire list every
   * pollInterval (that duplicated work and exhausted Knex pools).
   */
  async reprocess() {
    const redis = await getRedisConnection()
    const max = config.notificationRetryBatchMax
    const notifications: NotificationRow[] = []
    for (let i = 0; i < max; i++) {
      const raw = await redis.lPop(NOTIFICATION_RETRY_QUEUE_REDIS_KEY)
      if (raw === null || raw === undefined) {
        break
      }
      try {
        notifications.push(JSON.parse(raw as string) as NotificationRow)
      } catch (e) {
        logger.error(
          { err: e, raw: String(raw).slice(0, 200) },
          'notification_retry: invalid JSON, dropping entry'
        )
      }
    }
    await this.process(notifications, { requeuePoppedRetries: true })
  }
}
