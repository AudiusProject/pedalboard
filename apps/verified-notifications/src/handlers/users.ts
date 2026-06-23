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

// Fires off the dedicated `user_verified` NOTIFY channel, which the DB trigger
// (api ddl/functions/notify_on_row.sql) emits ONLY on a genuine verification
// transition — false -> true on an in-place update, or a brand-new row that
// arrives already verified.
//
// We used to listen on the `users` firehose and reconstruct the prior
// verification state here (first from revert_blocks, then from a `users`
// blocknumber lookback). Both broke under the Go ETL: it writes `users` in
// place (one is_current row per user, no versioned history), so there is no
// "previous" row to compare against and every profile edit by an
// already-verified user re-fired. The transition is now detected in the
// trigger via its OLD row, so this handler just announces — no lookback.
export default async (
  app: App<AppData>,
  msg: { user_id: number; blocknumber: number }
): Promise<void> => {
  const { user_id, blocknumber } = msg
  if (user_id === undefined) {
    logger.warn({ msg }, 'no user_id in user_verified payload')
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

  // Belt-and-suspenders: the trigger already gated on the transition, but guard
  // against a verification that was reverted between the NOTIFY and this read.
  if (!current.is_verified) {
    logger.debug({ user_id, blocknumber }, 'no longer verified, skipping')
    return
  }

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
