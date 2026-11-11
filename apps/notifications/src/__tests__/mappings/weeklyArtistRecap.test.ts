import { expect, jest, test } from '@jest/globals'
import { Processor } from '../../main'
import * as sns from '../../sns'
import * as web from '../../web'

import {
  createUsers,
  insertMobileDevices,
  insertMobileSettings,
  insertNotifications,
  setupTest,
  resetTests
} from '../../utils/populateDB'
import { weeklyArtistRecapMessages } from '../../processNotifications/mappers/weeklyArtistRecap'

describe('Weekly Artist Recap Notification', () => {
  let processor: Processor

  const sendPushNotificationSpy = jest
    .spyOn(sns, 'sendPushNotification')
    .mockImplementation(() => Promise.resolve({ endpointDisabled: false }))

  const sendBrowserNotificationSpy = jest
    .spyOn(web, 'sendBrowserNotification')
    .mockImplementation(() => Promise.resolve(1))

  beforeEach(async () => {
    const setup = await setupTest()
    processor = setup.processor
  })

  afterEach(async () => {
    await resetTests(processor)
  })

  test('Sends the recap to the artist', async () => {
    await createUsers(processor.discoveryDB, [{ user_id: 1 }])
    await insertMobileSettings(processor.identityDB, [{ userId: 1 }])
    await insertMobileDevices(processor.identityDB, [{ userId: 1 }])

    await insertNotifications(processor.discoveryDB, [
      {
        specifier: '1',
        group_id: 'weekly_artist_recap:2026-37:1',
        type: 'weekly_artist_recap',
        blocknumber: null,
        timestamp: new Date(Date.now()),
        data: {
          year: 2026,
          week: 37,
          play_count: 1240,
          follower_count: 18,
          save_count: 42,
          rotation_save_count: 5,
          top_city: 'Atlanta'
        },
        user_ids: [1]
      }
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    const pending = processor.listener.takePending()
    expect(pending?.appNotifications).toHaveLength(1)
    await processor.appNotificationsProcessor.process(pending.appNotifications)

    const body = '1,240 plays, 18 new followers, top city Atlanta, 42 saves'
    expect(sendPushNotificationSpy).toHaveBeenCalledWith(
      {
        type: 'ios',
        targetARN: 'arn:1',
        badgeCount: 1
      },
      {
        title: weeklyArtistRecapMessages.title,
        body,
        data: {
          id: 'timestamp:1589373217:group_id:weekly_artist_recap:2026-37:1',
          userIds: [1],
          type: 'WeeklyArtistRecap'
        }
      }
    )
    expect(sendBrowserNotificationSpy).toHaveBeenCalledWith(
      true,
      expect.any(Object),
      1,
      weeklyArtistRecapMessages.title,
      body
    )
  })

  test('Leaves out zero counts and a missing city', () => {
    expect(
      weeklyArtistRecapMessages.body({
        playCount: 1,
        followerCount: 0,
        saveCount: 0
      })
    ).toBe('1 play')
    expect(
      weeklyArtistRecapMessages.body({
        playCount: 3,
        followerCount: 1,
        saveCount: 1
      })
    ).toBe('3 plays, 1 new follower, 1 save')
  })
})
