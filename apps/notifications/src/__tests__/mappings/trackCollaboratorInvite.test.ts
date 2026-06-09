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
  resetTests,
  setUserEmailAndSettings,
  setupTest
} from '../../utils/populateDB'

describe('Track Collaborator Invite', () => {
  let processor: Processor

  const sendPushNotificationSpy = jest
    .spyOn(sns, 'sendPushNotification')
    .mockImplementation(() => Promise.resolve({ endpointDisabled: false }))

  const sendBrowserNotificationSpy = jest
    .spyOn(web, 'sendBrowserNotification')
    .mockImplementation(() => Promise.resolve(3))

  beforeEach(async () => {
    const setup = await setupTest()
    processor = setup.processor
  })

  afterEach(async () => {
    await resetTests(processor)
  })

  test('Process push notification for track collaborator invite', async () => {
    // user 1 = invited collaborator (recipient), user 2 = inviter / track owner
    await createUsers(processor.discoveryDB, [{ user_id: 1 }, { user_id: 2 }])
    await createTracks(processor.discoveryDB, [
      { track_id: 10, owner_id: 2 }
    ])
    await setUserEmailAndSettings(processor.identityDB, 'live', 1)

    await insertNotifications(processor.discoveryDB, [
      {
        id: 1,
        specifier: '2',
        group_id:
          'track_collaborator_invite:track_id:10:collaborator_user_id:1:inviter_user_id:2',
        type: 'track_collaborator_invite',
        data: {
          track_id: 10,
          collaborator_user_id: 1,
          inviter_user_id: 2
        },
        user_ids: [1]
      }
    ])

    await insertMobileSettings(processor.identityDB, [{ userId: 1 }])
    await insertMobileDevices(processor.identityDB, [{ userId: 1 }])

    const pending = processor.listener.takePending()
    expect(pending?.appNotifications).toHaveLength(1)

    const title = 'Track Collaboration Invite'
    const body = 'user_2 invited you to collaborate on track_title_10.'
    await processor.appNotificationsProcessor.process(pending.appNotifications)

    expect(sendPushNotificationSpy).toHaveBeenCalledWith(
      {
        type: 'ios',
        targetARN: 'arn:1',
        badgeCount: 1
      },
      expect.objectContaining({
        title,
        body,
        data: expect.objectContaining({
          type: 'TrackCollaboratorInvite',
          entityId: 10
        })
      })
    )

    expect(sendBrowserNotificationSpy).toHaveBeenCalledWith(
      true,
      expect.any(Object),
      1,
      title,
      body
    )
  })
})
