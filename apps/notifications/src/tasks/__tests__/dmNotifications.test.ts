import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test
} from '@jest/globals'
import type { Knex } from 'knex'
import { config } from '../../config'
import { Message } from '../../processNotifications/mappers/message'
import { MessageReaction } from '../../processNotifications/mappers/messageReaction'
import * as redisConnection from '../../utils/redisConnection'
import { makeChatId } from '../../utils/chatId'
import {
  getNewBlasts,
  getUnreadMessages,
  getUnreadReactions,
  sendDMNotifications
} from '../dmNotifications'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Call = { method: string; args: any[] }

// Records a single knex query-builder chain. Every builder method returns
// `this` so arbitrary chains work; awaiting the chain resolves via the
// resolver the test supplied (thenable).
class MockQuery {
  calls: Call[] = []

  constructor(private resolver: (q: MockQuery) => any) {}

  record(method: string, args: any[]): this {
    this.calls.push({ method, args })
    return this
  }

  then(onFulfilled?: (value: any) => any, onRejected?: (reason: any) => any) {
    let result
    try {
      result = this.resolver(this)
    } catch (err) {
      return Promise.reject(err).then(onFulfilled, onRejected)
    }
    return Promise.resolve(result).then(onFulfilled, onRejected)
  }

  // -- helpers for routing/assertions --
  callsOf(method: string): any[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args)
  }

  has(method: string): boolean {
    return this.calls.some((c) => c.method === method)
  }

  table(): string | undefined {
    return this.callsOf('from')[0]?.[0]
  }

  orderByDirection(): string | undefined {
    return this.callsOf('orderBy')[0]?.[1]
  }

  rawSql(): string | undefined {
    return this.callsOf('raw')[0]?.[0]
  }

  rawBindings(): any[] | undefined {
    return this.callsOf('raw')[0]?.[1]
  }
}

const CHAINABLE_METHODS = [
  'select',
  'from',
  'innerJoin',
  'joinRaw',
  'where',
  'andWhere',
  'whereIn',
  'whereRaw',
  'andWhereRaw',
  'orderBy',
  'limit',
  'first'
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const method of CHAINABLE_METHODS) {
  ;(MockQuery.prototype as any)[method] = function (...args: any[]) {
    return this.record(method, args)
  }
}

// A fake Knex instance: each root-level builder call starts a new MockQuery
// chain, and `raw` starts a chain holding the sql + bindings. All started
// queries are kept on `queries` for assertions.
type MockDb = Knex & { queries: MockQuery[] }

function createMockDb(resolver: (q: MockQuery) => any): MockDb {
  const queries: MockQuery[] = []
  const db: any = { queries }
  for (const method of CHAINABLE_METHODS) {
    db[method] = (...args: any[]) => {
      const q = new MockQuery(resolver)
      queries.push(q)
      return q.record(method, args)
    }
  }
  db.raw = (sql: string, bindings?: any) => {
    const q = new MockQuery(resolver)
    queries.push(q)
    return q.record('raw', [sql, bindings])
  }
  return db as MockDb
}

function createMockRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string | number) => {
      store.set(key, String(value))
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key)
    })
  }
}

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000)

// ---------------------------------------------------------------------------
// getUnreadMessages
// ---------------------------------------------------------------------------

describe('getUnreadMessages', () => {
  const minTimestamp = secondsAgo(60)
  const maxTimestamp = secondsAgo(1)

  test('returns unread message rows from the DB', async () => {
    const rows = [
      {
        chat_id: 'chat1',
        sender_user_id: 1,
        receiver_user_id: 2,
        timestamp: secondsAgo(30)
      }
    ]
    const db = createMockDb(() => rows)

    const result = await getUnreadMessages(db, minTimestamp, maxTimestamp)

    expect(result).toEqual(rows)
  })

  test('queries chat_message excluding blasts, bounded by min/max cursors', async () => {
    const db = createMockDb(() => [])

    await getUnreadMessages(db, minTimestamp, maxTimestamp)

    expect(db.queries).toHaveLength(1)
    const q = db.queries[0]
    expect(q.table()).toBe('chat_message')
    // blast messages are excluded from the regular DM query
    expect(q.callsOf('where')[0]).toEqual(['chat_message.blast_id', null])
    // aliases created_at so downstream mappers read notification.timestamp
    expect(q.callsOf('select')[0]).toContain(
      'chat_message.created_at as timestamp'
    )
    // lower bound (exclusive of last indexed message) and upper bound
    const [lowerSql, lowerBindings] = q.callsOf('whereRaw')[0]
    expect(lowerSql).toContain('chat_message.created_at >=')
    expect(lowerBindings).toEqual([minTimestamp.toISOString()])
    const [upperSql, upperBindings] = q.callsOf('andWhereRaw')[0]
    expect(upperSql).toContain('chat_message.created_at <')
    expect(upperBindings).toEqual([maxTimestamp.toISOString()])
    // only messages the member has not seen (last_active_at guard) and not
    // messages the member sent themselves
    const andWhereRawSqls = q.callsOf('andWhereRaw').map((args) => args[0])
    expect(
      andWhereRawSqls.some((sql) => sql.includes('chat_member.last_active_at'))
    ).toBe(true)
    expect(andWhereRawSqls).toContain(
      'chat_message.user_id != chat_member.user_id'
    )
  })

  test('returns empty array when there are no unread messages', async () => {
    const db = createMockDb(() => [])
    await expect(
      getUnreadMessages(db, minTimestamp, maxTimestamp)
    ).resolves.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getUnreadReactions
// ---------------------------------------------------------------------------

describe('getUnreadReactions', () => {
  const minTimestamp = secondsAgo(60)
  const maxTimestamp = secondsAgo(1)

  test('returns unread reaction rows from the DB', async () => {
    const rows = [
      {
        chat_id: 'chat1',
        message_id: 'message1',
        sender_user_id: 2,
        receiver_user_id: 1,
        reaction: 'heart',
        timestamp: secondsAgo(30)
      }
    ]
    const db = createMockDb(() => rows)

    const result = await getUnreadReactions(db, minTimestamp, maxTimestamp)

    expect(result).toEqual(rows)
  })

  test('queries chat_message_reactions bounded by min/max cursors', async () => {
    const db = createMockDb(() => [])

    await getUnreadReactions(db, minTimestamp, maxTimestamp)

    expect(db.queries).toHaveLength(1)
    const q = db.queries[0]
    expect(q.table()).toBe('chat_message_reactions')
    // aliases updated_at so downstream mappers read notification.timestamp
    expect(q.callsOf('select')[0]).toContain(
      'chat_message_reactions.updated_at as timestamp'
    )
    const [lowerSql, lowerBindings] = q.callsOf('whereRaw')[0]
    expect(lowerSql).toContain('chat_message_reactions.updated_at >=')
    expect(lowerBindings).toEqual([minTimestamp.toISOString()])
    const [upperSql, upperBindings] = q.callsOf('andWhereRaw')[0]
    expect(upperSql).toContain('chat_message_reactions.updated_at <')
    expect(upperBindings).toEqual([maxTimestamp.toISOString()])
    // reactions on your own message only (join), never your own reaction
    const andWhereRawSqls = q.callsOf('andWhereRaw').map((args) => args[0])
    expect(andWhereRawSqls).toContain(
      'chat_message_reactions.user_id != chat_member.user_id'
    )
  })

  test('returns empty array when there are no unread reactions', async () => {
    const db = createMockDb(() => [])
    await expect(
      getUnreadReactions(db, minTimestamp, maxTimestamp)
    ).resolves.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getNewBlasts
// ---------------------------------------------------------------------------

describe('getNewBlasts', () => {
  const blastCreatedAt = secondsAgo(120)

  // Routes the queries getNewBlasts makes:
  // 1. chat_blast + where          -> created_at lookup for the cursor blast
  // 2. chat_blast + orderBy desc   -> latest blast (first run, no cursor)
  // 3. raw                         -> audience batch for the current blast
  // 4. chat_blast + orderBy asc    -> next blast after the current one
  function createBlastDb({
    cursorBlastTimestamp,
    latestBlast,
    audienceRows,
    nextBlast
  }: {
    cursorBlastTimestamp?: Date
    latestBlast?: { blast_id: string; created_at: Date }
    audienceRows: any[]
    nextBlast?: { blast_id: string }
  }) {
    return createMockDb((q) => {
      if (q.has('raw')) {
        return { rows: audienceRows }
      }
      if (q.table() === 'chat_blast' && q.has('where')) {
        return cursorBlastTimestamp
          ? { timestamp: cursorBlastTimestamp }
          : undefined
      }
      if (q.table() === 'chat_blast' && q.orderByDirection() === 'desc') {
        return latestBlast
      }
      if (q.table() === 'chat_blast' && q.orderByDirection() === 'asc') {
        return nextBlast
      }
      throw new Error('unexpected query in getNewBlasts test')
    })
  }

  test('returns blast messages with populated timestamp and computed chat_id', async () => {
    const audienceRows = [
      {
        blast_id: 'blast1',
        sender_user_id: 10,
        receiver_user_id: 20,
        timestamp: blastCreatedAt
      },
      {
        blast_id: 'blast1',
        sender_user_id: 10,
        receiver_user_id: 30,
        timestamp: blastCreatedAt
      }
    ]
    const db = createBlastDb({
      cursorBlastTimestamp: blastCreatedAt,
      audienceRows
    })

    const result = await getNewBlasts(db, 'blast1', undefined)

    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toEqual({
      blast_id: 'blast1',
      sender_user_id: 10,
      receiver_user_id: 20,
      timestamp: blastCreatedAt,
      chat_id: makeChatId([10, 20])
    })
    expect(result.messages[1].chat_id).toBe(makeChatId([10, 30]))
    // every message carries the blast's created_at as its timestamp
    expect(result.messages.every((m) => m.timestamp === blastCreatedAt)).toBe(
      true
    )
  })

  test('selects created_at aliased AS timestamp so notification.timestamp is populated', async () => {
    const db = createBlastDb({
      cursorBlastTimestamp: blastCreatedAt,
      audienceRows: []
    })

    await getNewBlasts(db, 'blast1', undefined)

    const rawQuery = db.queries.find((q) => q.has('raw'))
    expect(rawQuery.rawSql()).toMatch(/created_at\s+AS\s+timestamp/i)
  })

  test('applies the chat_allowed check for every batch (user-id guard is parenthesized)', async () => {
    const db = createBlastDb({
      cursorBlastTimestamp: blastCreatedAt,
      audienceRows: []
    })

    await getNewBlasts(db, 'blast1', 20)

    const rawQuery = db.queries.find((q) => q.has('raw'))
    // chat_allowed must apply to ALL batches: the user-id cursor condition is
    // grouped in parens so it cannot OR away the chat_allowed filter on
    // batches after the first.
    expect(rawQuery.rawSql()).toMatch(
      /WHERE chat_allowed\(from_user_id, to_user_id\)\s+AND \(\?::INTEGER IS NULL OR to_user_id > \?\)/
    )
    expect(rawQuery.rawBindings()).toEqual([
      'blast1',
      20,
      20,
      config.blastUserBatchSize
    ])
  })

  test('advances the user-id cursor to the last recipient of the batch', async () => {
    const audienceRows = [
      {
        blast_id: 'blast1',
        sender_user_id: 10,
        receiver_user_id: 21,
        timestamp: blastCreatedAt
      },
      {
        blast_id: 'blast1',
        sender_user_id: 10,
        receiver_user_id: 45,
        timestamp: blastCreatedAt
      }
    ]
    const db = createBlastDb({
      cursorBlastTimestamp: blastCreatedAt,
      audienceRows
    })

    const result = await getNewBlasts(db, 'blast1', 20)

    expect(result.lastIndexedBlastId).toBe('blast1')
    expect(result.lastIndexedBlastUserId).toBe(45)
  })

  test('advances to the next blast and resets the user cursor when the batch is empty', async () => {
    const db = createBlastDb({
      cursorBlastTimestamp: blastCreatedAt,
      audienceRows: [],
      nextBlast: { blast_id: 'blast2' }
    })

    const result = await getNewBlasts(db, 'blast1', 45)

    expect(result.lastIndexedBlastId).toBe('blast2')
    expect(result.lastIndexedBlastUserId).toBeNull()
    expect(result.messages).toEqual([])
  })

  test('keeps the cursor when the batch is empty and there is no next blast', async () => {
    const db = createBlastDb({
      cursorBlastTimestamp: blastCreatedAt,
      audienceRows: []
    })

    const result = await getNewBlasts(db, 'blast1', 45)

    expect(result.lastIndexedBlastId).toBe('blast1')
    expect(result.lastIndexedBlastUserId).toBe(45)
    expect(result.messages).toEqual([])
  })

  test('first run without a cursor fast-forwards to the latest blast without sending', async () => {
    const audienceRows = [
      {
        blast_id: 'blastZ',
        sender_user_id: 10,
        receiver_user_id: 20,
        timestamp: blastCreatedAt
      }
    ]
    const db = createBlastDb({
      latestBlast: { blast_id: 'blastZ', created_at: blastCreatedAt },
      audienceRows
    })

    const result = await getNewBlasts(db, undefined, undefined)

    // no backfill flood: nothing is sent...
    expect(result.messages).toEqual([])
    // ...but the cursor is initialized so future blasts get processed
    expect(result.lastIndexedBlastId).toBe('blastZ')
    expect(result.lastIndexedBlastUserId).toBe(20)
  })

  test('first run with no blasts at all returns no messages and no cursor', async () => {
    const db = createBlastDb({ audienceRows: [] })

    const result = await getNewBlasts(db, undefined, undefined)

    expect(result.messages).toEqual([])
    expect(result.lastIndexedBlastId).toBeUndefined()
    expect(result.lastIndexedBlastUserId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// sendDMNotifications
// ---------------------------------------------------------------------------

describe('sendDMNotifications', () => {
  const identityDB = createMockDb(() => {
    throw new Error('identityDB should not be queried in these tests')
  })

  let redis: ReturnType<typeof createMockRedis>
  let messageSpy: ReturnType<typeof jest.spyOn>
  let reactionSpy: ReturnType<typeof jest.spyOn>
  const originalMaxAgeMs = config.dmNotificationMaxAgeMs

  beforeEach(() => {
    messageSpy = jest
      .spyOn(Message.prototype, 'processNotification')
      .mockResolvedValue(undefined)
    reactionSpy = jest
      .spyOn(MessageReaction.prototype, 'processNotification')
      .mockResolvedValue(undefined)
  })

  afterEach(() => {
    config.dmNotificationMaxAgeMs = originalMaxAgeMs
    jest.restoreAllMocks()
  })

  function setup({
    messageRows = [] as any[],
    reactionRows = [] as any[],
    blastRows = [] as any[],
    blastCreatedAt = undefined as Date | undefined,
    redisInit = {} as Record<string, string>
  } = {}) {
    redis = createMockRedis(redisInit)
    jest
      .spyOn(redisConnection, 'getRedisConnection')
      .mockResolvedValue(redis as any)

    const discoveryDB = createMockDb((q) => {
      if (q.has('raw')) {
        return { rows: blastRows }
      }
      switch (q.table()) {
        case 'chat_message':
          return messageRows
        case 'chat_message_reactions':
          return reactionRows
        case 'chat_blast':
          if (q.has('where')) {
            // created_at lookup for the blast id cursor
            return blastCreatedAt ? { timestamp: blastCreatedAt } : undefined
          }
          // latest-blast (desc) / next-blast (asc) lookups
          return undefined
        default:
          throw new Error(`unexpected query on table ${q.table()}`)
      }
    })
    return discoveryDB
  }

  // notifications actually pushed, in processing order
  const sentNotifications = () =>
    [...messageSpy.mock.contexts, ...reactionSpy.mock.contexts].map(
      (instance: any) => instance.notification
    )

  test('sends pushes for messages, reactions and blasts and advances all cursors', async () => {
    const messageRow = {
      chat_id: 'chat1',
      sender_user_id: 1,
      receiver_user_id: 2,
      timestamp: secondsAgo(30)
    }
    const reactionRow = {
      chat_id: 'chat1',
      message_id: 'message1',
      sender_user_id: 2,
      receiver_user_id: 1,
      reaction: 'fire',
      timestamp: secondsAgo(20)
    }
    const blastCreatedAt = secondsAgo(10)
    const blastRow = {
      blast_id: 'blast1',
      sender_user_id: 5,
      receiver_user_id: 6,
      timestamp: blastCreatedAt
    }
    const discoveryDB = setup({
      messageRows: [messageRow],
      reactionRows: [reactionRow],
      blastRows: [blastRow],
      blastCreatedAt,
      redisInit: {
        [config.lastIndexedMessageRedisKey]: secondsAgo(60).toISOString(),
        [config.lastIndexedReactionRedisKey]: secondsAgo(60).toISOString(),
        [config.lastIndexedBlastIdRedisKey]: 'blast1'
      }
    })

    await sendDMNotifications(discoveryDB, identityDB)

    // message + blast go through the Message mapper, reaction through
    // MessageReaction
    expect(messageSpy).toHaveBeenCalledTimes(2)
    expect(reactionSpy).toHaveBeenCalledTimes(1)

    // cursors advance to the newest processed notification of each type
    expect(redis.store.get(config.lastIndexedMessageRedisKey)).toBe(
      messageRow.timestamp.toISOString()
    )
    expect(redis.store.get(config.lastIndexedReactionRedisKey)).toBe(
      reactionRow.timestamp.toISOString()
    )
    expect(redis.store.get(config.lastIndexedBlastIdRedisKey)).toBe('blast1')
    expect(redis.store.get(config.lastIndexedBlastUserIdRedisKey)).toBe('6')
  })

  test('processes notifications in ascending timestamp order', async () => {
    const olderMessage = {
      chat_id: 'chat1',
      sender_user_id: 1,
      receiver_user_id: 2,
      timestamp: secondsAgo(50)
    }
    const newerMessage = {
      chat_id: 'chat2',
      sender_user_id: 3,
      receiver_user_id: 4,
      timestamp: secondsAgo(10)
    }
    const reactionRow = {
      chat_id: 'chat1',
      message_id: 'message1',
      sender_user_id: 2,
      receiver_user_id: 1,
      reaction: 'fire',
      timestamp: secondsAgo(30)
    }
    // deliberately out of order
    const discoveryDB = setup({
      messageRows: [newerMessage, olderMessage],
      reactionRows: [reactionRow]
    })

    await sendDMNotifications(discoveryDB, identityDB)

    const messageOrder = messageSpy.mock.invocationCallOrder
    const reactionOrder = reactionSpy.mock.invocationCallOrder
    const messageTimestamps = messageSpy.mock.contexts.map(
      (instance: any) => instance.notification.timestamp
    )
    // older message first, then the reaction, then the newer message
    expect(messageTimestamps).toEqual([
      olderMessage.timestamp,
      newerMessage.timestamp
    ])
    expect(messageOrder[0]).toBeLessThan(reactionOrder[0])
    expect(reactionOrder[0]).toBeLessThan(messageOrder[1])
  })

  test('age guard: skips pushes for too-old messages and reactions but still advances cursors', async () => {
    config.dmNotificationMaxAgeMs = 60 * 1000
    const oldMessage = {
      chat_id: 'chat1',
      sender_user_id: 1,
      receiver_user_id: 2,
      timestamp: secondsAgo(2 * 60 * 60)
    }
    const oldReaction = {
      chat_id: 'chat1',
      message_id: 'message1',
      sender_user_id: 2,
      receiver_user_id: 1,
      reaction: 'fire',
      timestamp: secondsAgo(2 * 60 * 60)
    }
    const discoveryDB = setup({
      messageRows: [oldMessage],
      reactionRows: [oldReaction]
    })

    await sendDMNotifications(discoveryDB, identityDB)

    expect(messageSpy).not.toHaveBeenCalled()
    expect(reactionSpy).not.toHaveBeenCalled()
    // cursors still advance so the old notifications are not reprocessed
    expect(redis.store.get(config.lastIndexedMessageRedisKey)).toBe(
      oldMessage.timestamp.toISOString()
    )
    expect(redis.store.get(config.lastIndexedReactionRedisKey)).toBe(
      oldReaction.timestamp.toISOString()
    )
  })

  test('age guard: fresh notifications are still sent when old ones are skipped', async () => {
    config.dmNotificationMaxAgeMs = 60 * 1000
    const oldMessage = {
      chat_id: 'chat1',
      sender_user_id: 1,
      receiver_user_id: 2,
      timestamp: secondsAgo(2 * 60 * 60)
    }
    const freshMessage = {
      chat_id: 'chat2',
      sender_user_id: 3,
      receiver_user_id: 4,
      timestamp: secondsAgo(10)
    }
    const discoveryDB = setup({ messageRows: [oldMessage, freshMessage] })

    await sendDMNotifications(discoveryDB, identityDB)

    expect(messageSpy).toHaveBeenCalledTimes(1)
    expect(sentNotifications()).toEqual([freshMessage])
  })

  test('blast notifications are exempt from the age guard', async () => {
    config.dmNotificationMaxAgeMs = 60 * 1000
    // blast created long before the cutoff: still working through a large
    // audience must not drop the remaining recipients
    const blastCreatedAt = secondsAgo(2 * 60 * 60)
    const blastRows = [
      {
        blast_id: 'blast1',
        sender_user_id: 5,
        receiver_user_id: 6,
        timestamp: blastCreatedAt
      },
      {
        blast_id: 'blast1',
        sender_user_id: 5,
        receiver_user_id: 7,
        timestamp: blastCreatedAt
      }
    ]
    // an equally old regular message is skipped in the same run
    const oldMessage = {
      chat_id: 'chat1',
      sender_user_id: 1,
      receiver_user_id: 2,
      timestamp: secondsAgo(2 * 60 * 60)
    }
    const discoveryDB = setup({
      messageRows: [oldMessage],
      blastRows,
      blastCreatedAt,
      redisInit: { [config.lastIndexedBlastIdRedisKey]: 'blast1' }
    })

    await sendDMNotifications(discoveryDB, identityDB)

    // only the two blast recipients get pushes; the old DM does not
    expect(messageSpy).toHaveBeenCalledTimes(2)
    const sent = sentNotifications()
    expect(sent.every((n: any) => n.blast_id === 'blast1')).toBe(true)
    // blast cursor advances through the audience
    expect(redis.store.get(config.lastIndexedBlastUserIdRedisKey)).toBe('7')
  })

  test('maxAgeMs = 0 disables the age guard entirely', async () => {
    config.dmNotificationMaxAgeMs = 0
    const veryOldMessage = {
      chat_id: 'chat1',
      sender_user_id: 1,
      receiver_user_id: 2,
      timestamp: secondsAgo(365 * 24 * 60 * 60)
    }
    const discoveryDB = setup({ messageRows: [veryOldMessage] })

    await sendDMNotifications(discoveryDB, identityDB)

    expect(messageSpy).toHaveBeenCalledTimes(1)
  })

  test('no new activity: sends nothing and initializes cursors', async () => {
    const before = Date.now()
    const discoveryDB = setup()

    await sendDMNotifications(discoveryDB, identityDB)

    expect(messageSpy).not.toHaveBeenCalled()
    expect(reactionSpy).not.toHaveBeenCalled()

    // message/reaction cursors initialize to the max cursor
    // (now - dmNotificationDelay)
    for (const key of [
      config.lastIndexedMessageRedisKey,
      config.lastIndexedReactionRedisKey
    ]) {
      const cursor = Date.parse(redis.store.get(key))
      expect(cursor).toBeGreaterThanOrEqual(before - config.dmNotificationDelay)
      expect(cursor).toBeLessThanOrEqual(
        Date.now() - config.dmNotificationDelay
      )
    }
    // no blasts exist: blast id cursor is not written, user id cursor cleared
    expect(redis.store.has(config.lastIndexedBlastIdRedisKey)).toBe(false)
    expect(redis.del).toHaveBeenCalledWith(
      config.lastIndexedBlastUserIdRedisKey
    )
  })

  test('uses cached redis timestamps as the min cursors for DB queries', async () => {
    const messageCursor = secondsAgo(45)
    const reactionCursor = secondsAgo(90)
    const discoveryDB = setup({
      redisInit: {
        [config.lastIndexedMessageRedisKey]: messageCursor.toISOString(),
        [config.lastIndexedReactionRedisKey]: reactionCursor.toISOString()
      }
    })

    await sendDMNotifications(discoveryDB, identityDB)

    const messageQuery = discoveryDB.queries.find(
      (q) => q.table() === 'chat_message'
    )
    expect(messageQuery.callsOf('whereRaw')[0][1]).toEqual([
      messageCursor.toISOString()
    ])
    const reactionQuery = discoveryDB.queries.find(
      (q) => q.table() === 'chat_message_reactions'
    )
    expect(reactionQuery.callsOf('whereRaw')[0][1]).toEqual([
      reactionCursor.toISOString()
    ])
  })

  test('does not advance cursors when processing a notification fails', async () => {
    messageSpy.mockRejectedValue(new Error('sns exploded'))
    const messageRow = {
      chat_id: 'chat1',
      sender_user_id: 1,
      receiver_user_id: 2,
      timestamp: secondsAgo(30)
    }
    const discoveryDB = setup({ messageRows: [messageRow] })

    // the task swallows the error (logs it) instead of crashing the plugin
    await expect(
      sendDMNotifications(discoveryDB, identityDB)
    ).resolves.toBeUndefined()

    // cursors were not written, so the notification is retried next tick
    expect(redis.set).not.toHaveBeenCalled()
  })
})
