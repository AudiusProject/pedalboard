import { expect, jest, test } from '@jest/globals'
import { Processor } from '../../main'
import * as sns from '../../sns'

import {
  createUsers,
  insertMobileDevices,
  insertMobileSettings,
  insertNotifications,
  createTracks,
  setupTest,
  resetTests
} from '../../utils/populateDB'

describe('Trending Genre Notification', () => {
  let processor: Processor

  const sendPushNotificationSpy = jest
    .spyOn(sns, 'sendPushNotification')
    .mockImplementation(() => Promise.resolve({ endpointDisabled: false }))

  beforeEach(async () => {
    const setup = await setupTest()
    processor = setup.processor
    sendPushNotificationSpy.mockClear()
  })

  afterEach(async () => {
    await resetTests(processor)
  })

  const row = {
    id: 1,
    specifier: '10',
    group_id: 'trending_genre:2026-09-18:10',
    type: 'trending_genre',
    timestamp: new Date(Date.now()),
    data: { track_id: 10, genre: 'Dubstep', rank: 4, week: '2026-09-18' },
    user_ids: [1]
  }

  const process = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const pending = processor.listener.takePending()
    const notifications = pending.appNotifications.filter(
      (n) => n.type === 'trending_genre'
    )
    expect(notifications).toHaveLength(1)
    await processor.appNotificationsProcessor.process(notifications)
  }

  test('Process push notification for a genre chart rank', async () => {
    await createUsers(processor.discoveryDB, [{ user_id: 1 }])
    await createTracks(processor.discoveryDB, [
      { track_id: 10, owner_id: 1, cover_art_sizes: 'test-hash' }
    ])
    await insertNotifications(processor.discoveryDB, [row])
    await insertMobileSettings(processor.identityDB, [{ userId: 1 }])
    await insertMobileDevices(processor.identityDB, [{ userId: 1 }])

    await process()

    expect(sendPushNotificationSpy).toHaveBeenCalledWith(
      {
        type: 'ios',
        targetARN: 'arn:1',
        badgeCount: 1
      },
      {
        title: '📈 Charting in Dubstep',
        body: 'track_title_10 is #4 in Dubstep this week! Share it',
        data: {
          type: 'TrendingGenre',
          id: 'timestamp:1589373217:group_id:trending_genre:2026-09-18:10',
          entityId: 10,
          rank: 4,
          genre: 'Dubstep',
          shareCard: true
        },
        imageUrl: 'https://api.audius.co/content/test-hash/150x150.jpg'
      }
    )
  })

  test('Skips a deactivated artist', async () => {
    await createUsers(processor.discoveryDB, [
      { user_id: 1, is_deactivated: true }
    ])
    await createTracks(processor.discoveryDB, [{ track_id: 10, owner_id: 1 }])
    await insertNotifications(processor.discoveryDB, [row])
    await insertMobileSettings(processor.identityDB, [{ userId: 1 }])
    await insertMobileDevices(processor.identityDB, [{ userId: 1 }])

    await process()

    expect(sendPushNotificationSpy).not.toHaveBeenCalled()
  })
})
