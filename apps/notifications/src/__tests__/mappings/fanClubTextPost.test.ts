import { expect, jest, test } from '@jest/globals'
import { Processor } from '../../main'
import * as sns from '../../sns'
import {
  setupTest,
  setupTwoUsersWithDevices,
  insertNotifications,
  resetTests
} from '../../utils/populateDB'

describe('Fan Club Text Post Notification', () => {
  let processor: Processor
  const sendPushNotificationSpy = jest
    .spyOn(sns, 'sendPushNotification')
    .mockImplementation(() => Promise.resolve({ endpointDisabled: false }))

  beforeEach(async () => {
    const setup = await setupTest()
    processor = setup.processor
  })

  afterEach(async () => {
    await resetTests(processor)
  })

  test('Sends push notification for fan_club_text_post', async () => {
    const { user1 } = await setupTwoUsersWithDevices(
      processor.discoveryDB,
      processor.identityDB
    )

    // Insert artist user (entityUserId = 99)
    await processor.discoveryDB('users').insert({
      user_id: 99,
      name: 'ArtistName',
      is_current: true,
      created_at: new Date(),
      updated_at: new Date(),
      profile_picture_sizes: 'artist-pfp-hash'
    })

    await insertNotifications(processor.discoveryDB, [
      {
        type: 'fan_club_text_post',
        user_ids: [user1.userId],
        group_id: 'fan_club_text_post:100:user:99',
        specifier: String(user1.userId),
        timestamp: new Date(1589373217),
        data: { entity_user_id: 99, comment_id: 100 }
      }
    ])

    await new Promise((resolve) => setTimeout(resolve, 10))
    const pending = processor.listener.takePending()
    expect(pending?.appNotifications).toBeDefined()
    expect(pending.appNotifications).toHaveLength(1)

    await processor.appNotificationsProcessor.process(pending.appNotifications)

    expect(sendPushNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: user1.deviceType,
        targetARN: user1.awsARN,
        badgeCount: 1
      }),
      expect.objectContaining({
        title: 'New Fan Club Post',
        body: 'ArtistName posted in their fan club',
        data: expect.objectContaining({
          type: 'FanClubTextPost',
          entityUserId: 99,
          commentId: 100
        }),
        imageUrl:
          'https://creatornode2.audius.co/content/artist-pfp-hash/150x150.jpg'
      })
    )
  })

  test('Does not send push notification for deactivated receiver', async () => {
    const { user1 } = await setupTwoUsersWithDevices(
      processor.discoveryDB,
      processor.identityDB
    )

    // Deactivate the receiver
    await processor
      .discoveryDB('users')
      .where('user_id', user1.userId)
      .update({ is_deactivated: true })

    // Insert artist user
    await processor.discoveryDB('users').insert({
      user_id: 99,
      name: 'ArtistName',
      is_current: true,
      created_at: new Date(),
      updated_at: new Date()
    })

    await insertNotifications(processor.discoveryDB, [
      {
        type: 'fan_club_text_post',
        user_ids: [user1.userId],
        group_id: 'fan_club_text_post:100:user:99',
        specifier: String(user1.userId),
        timestamp: new Date(1589373217),
        data: { entity_user_id: 99, comment_id: 100 }
      }
    ])

    await new Promise((resolve) => setTimeout(resolve, 10))
    const pending = processor.listener.takePending()
    expect(pending?.appNotifications).toBeDefined()

    await processor.appNotificationsProcessor.process(pending.appNotifications)

    // No push sent for deactivated user
    expect(sendPushNotificationSpy).not.toHaveBeenCalled()
  })
})
