import type { App } from '@pedalboard/basekit'
import { slack } from '../slack'
import { createLogger } from '@pedalboard/logger'

const logger = createLogger('verified-notifications')

type AppData = { port: number }

type UserRow = {
  handle: string
  is_verified: boolean
  verified_with_twitter?: boolean
  verified_with_instagram?: boolean
  verified_with_tiktok?: boolean
}

// We resolve the "previous version" of the user directly from the versioned
// `users` table — the row with the largest blocknumber strictly less than the
// blocknumber that fired this NOTIFY. We used to walk Python's
// `revert_blocks.prev_records` for this, but the new Go ETL indexer doesn't
// populate revert_blocks, so any update to an already-verified user would look
// like a brand-new verified signup and the channel would re-fire every time a
// verified user touched their profile.
//
// Sourcing from `users` directly is also a strict improvement: revert_blocks is
// going away with the Python indexer, and the versioned `users` table is the
// real source of truth for what each row looked like before the change.
export default async (
  app: App<AppData>,
  msg: { user_id: number; blocknumber: number }
): Promise<void> => {
  const { user_id, blocknumber } = msg
  if (blocknumber === undefined) {
    logger.warn('no block number returned')
    return
  }

  const db = app.getDnDb()

  const current = (await db('users')
    .select(
      'handle',
      'is_verified',
      'verified_with_twitter',
      'verified_with_instagram',
      'verified_with_tiktok'
    )
    .where('user_id', '=', user_id)
    .andWhere('is_current', '=', true)
    .first()
    .catch((err: unknown) => {
      logger.error({ err, user_id }, 'users current query')
      return undefined
    })) as UserRow | undefined

  if (current === undefined) {
    logger.warn({ user_id, blocknumber }, 'user does not have a current record')
    return
  }

  const prev = (await db('users')
    .select('is_verified')
    .where('user_id', '=', user_id)
    .andWhere('blocknumber', '<', blocknumber)
    .orderBy('blocknumber', 'desc')
    .first()
    .catch((err: unknown) => {
      logger.error({ err, user_id, blocknumber }, 'users prev query')
      return undefined
    })) as { is_verified: boolean } | undefined

  // Fire only on the actual false → true transition (or a brand-new user that
  // arrives already verified). Re-firing on every is_current write to an
  // already-verified user — which is what was happening prior to this rewrite
  // — is exactly the noise we're trying to kill.
  const newly_signed_up_verified = prev === undefined && current.is_verified
  const became_verified =
    prev !== undefined && !prev.is_verified && current.is_verified

  logger.info(
    { user_id, blocknumber, current, prev, newly_signed_up_verified, became_verified },
    'user verification check'
  )

  if (!(newly_signed_up_verified || became_verified)) return

  let source: string
  if (current.verified_with_twitter) source = 'twitter'
  else if (current.verified_with_instagram) source = 'instagram'
  else if (current.verified_with_tiktok) source = 'tiktok'
  else source = 'manual'

  const header = `User *${current.handle}* is now verified via ${source}!`
  const body = {
    userId: user_id,
    handle: current.handle,
    link: `https://audius.co/${current.handle}`,
    source
  }

  const USERS_SLACK_CHANNEL = process.env.USERS_SLACK_CHANNEL!
  logger.info({ to_slack: body }, 'user verification')
  await slack
    .sendMsg(USERS_SLACK_CHANNEL, header, body as Record<string, unknown>)
    .catch((err: unknown) => logger.error({ err }, 'slack send'))
}
