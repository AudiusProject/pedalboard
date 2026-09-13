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
import { weeklyRotationMessages } from '../../processNotifications/mappers/weeklyRotation'

describe('Weekly Rotation Notification', () => {
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

  test('Process push notification for weekly rotation', async () => {
    await createUsers(processor.discoveryDB, [{ user_id: 1 }])
    await insertMobileSettings(processor.identityDB, [{ userId: 1 }])
    await insertMobileDevices(processor.identityDB, [{ userId: 1 }])

    await insertNotifications(processor.discoveryDB, [
      {
        specifier: '1',
        group_id: 'weekly_rotation:2026-37:1',
        type: 'weekly_rotation',
        blocknumber: null,
        timestamp: new Date(Date.now()),
        data: { year: 2026, week: 37 },
        user_ids: [1]
      }
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    const pending = processor.listener.takePending()
    expect(pending?.appNotifications).toHaveLength(1)
    await processor.appNotificationsProcessor.process(pending.appNotifications)

    expect(sendPushNotificationSpy).toHaveBeenCalledWith(
      {
        type: 'ios',
        targetARN: 'arn:1',
        badgeCount: 1
      },
      {
        title: weeklyRotationMessages.title,
        body: weeklyRotationMessages.body,
        data: {
          id: 'timestamp:1589373217:group_id:weekly_rotation:2026-37:1',
          userIds: [1],
          type: 'WeeklyRotation',
          entityType: 'User',
          entityId: 1
        }
      }
    )
    expect(sendBrowserNotificationSpy).toHaveBeenCalledWith(
      true,
      expect.any(Object),
      1,
      weeklyRotationMessages.title,
      weeklyRotationMessages.body
    )
  })

  test('Does not push to a user with no devices', async () => {
    await createUsers(processor.discoveryDB, [{ user_id: 2 }])

    await insertNotifications(processor.discoveryDB, [
      {
        specifier: '2',
        group_id: 'weekly_rotation:2026-37:2',
        type: 'weekly_rotation',
        blocknumber: null,
        timestamp: new Date(Date.now()),
        data: { year: 2026, week: 37 },
        user_ids: [2]
      }
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    const pending = processor.listener.takePending()
    expect(pending?.appNotifications).toHaveLength(1)
    await processor.appNotificationsProcessor.process(pending.appNotifications)

    expect(sendPushNotificationSpy).not.toHaveBeenCalled()
  })
})
