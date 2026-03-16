import type { App } from '@pedalboard/basekit'
import { slack } from '../slack'
import { createLogger } from '@pedalboard/logger'

const logger = createLogger('verified-notifications')

type AppData = { port: number }

type ArtistCoinsRow = {
  name: string
  mint: string
  ticker: string
  description: string
  user_id: number
}

export default async (app: App<AppData>, row: ArtistCoinsRow): Promise<void> => {
  const { name, mint, ticker, description, user_id } = row

  const db = app.getDnDb()
  const user = await db('users')
    .select('users.user_id', 'users.handle', 'users.name')
    .where('users.user_id', '=', user_id)
    .first()
    .catch((err) => {
      logger.error({ err }, 'users query')
      return undefined
    })

  if (!user) {
    logger.error({ user_id }, 'user not found')
    return
  }

  const ARTIST_COINS_SLACK_CHANNEL = process.env.ARTIST_COINS_SLACK_CHANNEL!
  const header = `*${(user as { name: string }).name}* (@${(user as { handle: string }).handle}) just launched ${name} ($${ticker})!`
  const data = {
    'Coin Name': name,
    'Coin Mint': mint,
    'Coin Ticker': ticker,
    'Coin Description': description,
    'User Name': (user as { name: string }).name,
    'User Handle': (user as { handle: string }).handle
  }

  await slack
    .sendMsg(ARTIST_COINS_SLACK_CHANNEL, header, data as Record<string, unknown>)
    .catch((err) => logger.error({ err }, 'slack send'))
}
