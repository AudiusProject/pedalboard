import { expect, jest, test } from '@jest/globals'
import { Processor } from '../../main'
import * as sns from '../../sns'
import * as web from '../../web'

import {
  createTracks,
  createUsers,
  insertMobileDevices,
  insertMobileSettings,
  insertNotifications,
  setupTest,
  resetTests
} from '../../utils/populateDB'
import { weeklyRotationFeaturedMessages } from '../../processNotifications/mappers/weeklyRotationFeatured'

describe('Weekly Rotation Featured Notification', () => {
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

  const processFeatured = async (data: {
    track_id: number
    track_count: number
    rotation_count: number
  }) => {
    await insertNotifications(processor.discoveryDB, [
      {
        specifier: '1',
        group_id: 'weekly_rotation_featured:2026-37:1',
        type: 'weekly_rotation_featured',
        blocknumber: null,
        timestamp: new Date(Date.now()),
        data: { year: 2026, week: 37, ...data },
        user_ids: [1]
      }
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    const pending = processor.listener.takePending()
    expect(pending?.appNotifications).toHaveLength(1)
    await processor.appNotificationsProcessor.process(pending.appNotifications)
  }

  test('One track: names it and opens it', async () => {
    await createUsers(processor.discoveryDB, [{ user_id: 1 }])
    await createTracks(processor.discoveryDB, [
      { track_id: 10, owner_id: 1, cover_art_sizes: 'test-hash' }
    ])
    await insertMobileSettings(processor.identityDB, [{ userId: 1 }])
    await insertMobileDevices(processor.identityDB, [{ userId: 1 }])

    await processFeatured({ track_id: 10, track_count: 1, rotation_count: 12 })

    const body =
      'Your track_title_10 was featured in 12 Weekly Rotations last week'
    expect(
      weeklyRotationFeaturedMessages.body({
        trackTitle: 'track_title_10',
        trackCount: 1,
        rotationCount: 12
      })
    ).toBe(body)
    expect(sendPushNotificationSpy).toHaveBeenCalledWith(
      {
        type: 'ios',
        targetARN: 'arn:1',
        badgeCount: 1
      },
      {
        title: weeklyRotationFeaturedMessages.title,
        body,
        data: {
          id: 'timestamp:1589373217:group_id:weekly_rotation_featured:2026-37:1',
          userIds: [1],
          type: 'WeeklyRotationFeatured',
          entityType: 'Track',
          entityId: 10
        },
        imageUrl: expect.stringContaining('test-hash')
      }
    )
    expect(sendBrowserNotificationSpy).toHaveBeenCalledWith(
      true,
      expect.any(Object),
      1,
      weeklyRotationFeaturedMessages.title,
      body
    )
  })

  test('One rotation is singular', async () => {
    expect(
      weeklyRotationFeaturedMessages.body({
        trackTitle: 'Song',
        trackCount: 1,
        rotationCount: 1
      })
    ).toBe('Your Song was featured in 1 Weekly Rotation last week')
  })

  test('Several tracks: aggregates and opens the profile', async () => {
    await createUsers(processor.discoveryDB, [{ user_id: 1 }])
    await createTracks(processor.discoveryDB, [
      { track_id: 10, owner_id: 1, cover_art_sizes: 'test-hash' },
      { track_id: 11, owner_id: 1 }
    ])
    await insertMobileSettings(processor.identityDB, [{ userId: 1 }])
    await insertMobileDevices(processor.identityDB, [{ userId: 1 }])

    await processFeatured({ track_id: 10, track_count: 2, rotation_count: 30 })

    const body = 'Your tracks were featured in 30 Weekly Rotations last week'
    expect(sendPushNotificationSpy).toHaveBeenCalledWith(
      {
        type: 'ios',
        targetARN: 'arn:1',
        badgeCount: 1
      },
      {
        title: weeklyRotationFeaturedMessages.title,
        body,
        data: {
          id: 'timestamp:1589373217:group_id:weekly_rotation_featured:2026-37:1',
          userIds: [1],
          type: 'WeeklyRotationFeatured',
          entityType: 'User',
          entityId: 1
        },
        imageUrl: undefined
      }
    )
  })
})
