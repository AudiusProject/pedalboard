import type { App } from '@pedalboard/basekit'
import { USDC } from '@audius/fixed-decimal'
import { slack } from '../slack'
import { createLogger } from '@pedalboard/logger'

const logger = createLogger('verified-notifications')

type AppData = { port: number }

type PurchaseRow = {
  buyer_user_id: number
  seller_user_id: number
  amount: string
  content_type: string
  content_id: number
  access: string
  extra_amount: string
  vendor: string
}

export default async (app: App<AppData>, row: PurchaseRow): Promise<void> => {
  const {
    buyer_user_id,
    seller_user_id,
    amount,
    content_type,
    content_id,
    access,
    extra_amount,
    vendor
  } = row

  const db = app.getDnDb()
  const users = await db('users')
    .select('users.user_id', 'users.handle', 'users.name')
    .where('users.user_id', '=', buyer_user_id)
    .orWhere('users.user_id', '=', seller_user_id)

  const buyer = users.find((u: { user_id: number }) => u.user_id === buyer_user_id)
  const seller = users.find((u: { user_id: number }) => u.user_id === seller_user_id)
  if (!buyer || !seller) {
    logger.warn({ buyer_user_id, seller_user_id }, 'buyer or seller not found')
    return
  }

  let contentMetadata: { title: string } | undefined
  if (content_type === 'track') {
    contentMetadata = await db('tracks')
      .select('tracks.title')
      .where('tracks.track_id', '=', content_id)
      .first() as { title: string } | undefined
  } else {
    contentMetadata = await db('playlists')
      .select('playlists.playlist_name as title')
      .where('playlists.playlist_id', '=', content_id)
      .first() as { title: string } | undefined
  }

  const PURCHASES_SLACK_CHANNEL = process.env.PURCHASES_SLACK_CHANNEL!
  const header = `*${(seller as { name: string }).name}* (@${(seller as { handle: string }).handle}) just made a sale!`
  const data = {
    buyer: `${(buyer as { name: string }).name} (@${(buyer as { handle: string }).handle})`,
    content_title: contentMetadata?.title ?? '',
    content_type,
    price: USDC(BigInt(amount)).toLocaleString(),
    payExtra: USDC(BigInt(extra_amount)).toLocaleString(),
    access,
    vendor,
    buyer_user_id,
    seller_user_id,
    content_id
  }

  await slack
    .sendMsg(PURCHASES_SLACK_CHANNEL, header, data as Record<string, unknown>)
    .catch((err) => logger.error({ err }, 'slack send'))
}
