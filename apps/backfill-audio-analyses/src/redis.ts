import { createClient, type RedisClientType } from 'redis'
import { getConfig } from './config'
import { logger } from './logger'

let redisClient: RedisClientType | undefined
let isReady = false

const parseArray = (json: string | null): Array<{ delegateOwnerWallet?: string; endpoint?: string }> => {
  try {
    const parsed = JSON.parse(json ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

export const getRedisConnection = async (): Promise<RedisClientType> => {
  if (!isReady || !redisClient) {
    redisClient = createClient({ url: getConfig().redisUrl })
    redisClient.on('ready', () => {
      isReady = true
    })
    await redisClient.connect()
  }
  return redisClient
}

export const storeDbOffset = async (key: string, offset: number): Promise<void> => {
  try {
    const redis = await getRedisConnection()
    await redis.set(key, offset.toString())
  } catch (e) {
    logger.error({ error: e }, 'could not store db offset')
  }
}

export const readDbOffset = async (key: string): Promise<number | null> => {
  try {
    const redis = await getRedisConnection()
    const cacheValue = await redis.get(key)
    if (cacheValue == null) return null
    return parseInt(cacheValue, 10)
  } catch (e) {
    logger.error({ error: e }, 'could not read db offset')
    return null
  }
}

export type ContentNode = {
  delegateOwnerWallet: string
  endpoint: string
}

export const getCachedHealthyContentNodes = async (): Promise<ContentNode[]> => {
  const redis = await getRedisConnection()
  const key = 'all-healthy-content-nodes'
  const json = await redis.get(key)
  return parseArray(json).filter(
    (p): p is ContentNode =>
      'delegateOwnerWallet' in p &&
      'endpoint' in p &&
      typeof p.delegateOwnerWallet === 'string' &&
      typeof p.endpoint === 'string'
  )
}
