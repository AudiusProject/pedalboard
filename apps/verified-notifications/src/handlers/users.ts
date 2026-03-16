import type { App } from '@pedalboard/basekit'
import { slack } from '../slack'
import { getPreviousState } from './utils'
import { createLogger } from '@pedalboard/logger'

const logger = createLogger('verified-notifications')

type AppData = { port: number }

// TODO: send blocknumber through pg trigger
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
  const current = await db('users')
    .select('handle', 'is_verified')
    .where('user_id', '=', user_id)
    .first()
    .catch((err) => {
      logger.error({ err }, 'users query')
      return undefined
    })
  const old = await getPreviousState({
    table: 'users',
    id: user_id,
    blocknumber,
    db
  })

  logger.info({ current, old, user_id, blocknumber })

  if (current === undefined) {
    logger.warn({ user_id, blocknumber }, 'user does not have a current record')
    return
  }

  const cur = current as {
    is_verified: boolean
    handle: string
    verified_with_twitter?: boolean
    verified_with_instagram?: boolean
    verified_with_tiktok?: boolean
  }
  const new_user_is_verified = !old && cur.is_verified
  const existing_user_became_verified = !old?.is_verified && cur.is_verified

  logger.info({
    user_id,
    existing_user_became_verified,
    new_user_is_verified
  })

  if (existing_user_became_verified || new_user_is_verified) {
    const is_verified = cur.is_verified
    const handle = cur.handle

    let source: string
    if (cur.verified_with_twitter) {
      source = 'twitter'
    } else if (cur.verified_with_instagram) {
      source = 'instagram'
    } else if (cur.verified_with_tiktok) {
      source = 'tiktok'
    } else {
      source = 'manual'
    }

    const header = `User *${handle}* ${
      is_verified ? 'is now' : 'is no longer'
    } verified via ${source}!`

    const body = {
      userId: user_id,
      handle,
      link: `https://audius.co/${handle}`,
      source
    }

    const USERS_SLACK_CHANNEL = process.env.USERS_SLACK_CHANNEL!
    logger.info({ to_slack: body }, 'user verification')
    await slack.sendMsg(USERS_SLACK_CHANNEL, header, body as Record<string, unknown>).catch((err) =>
      logger.error({ err }, 'slack send')
    )
  }
}
