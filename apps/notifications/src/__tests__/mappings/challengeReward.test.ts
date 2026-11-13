import { describe, expect, test, jest } from '@jest/globals'
import { Knex } from 'knex'
import { mapNotifications } from '../../processNotifications/mappers/mapNotifications'
import { NotificationRow } from '../../types/dn'
import { sendNotificationEmail } from '../../email/notifications/sendEmail'
import { renderEmail } from '../../email/notifications/renderEmail'
import { getSendgrid } from '../../sendgrid'

jest.mock('../../email/notifications/renderEmail')
jest.mock('../../sendgrid')

const row = (type: string): NotificationRow =>
  ({
    type,
    data: { challenge_id: 'tt', amount: '100000000000' },
    user_ids: [1],
    timestamp: new Date(),
    group_id: type,
    specifier: '1',
    blocknumber: 1
  } as NotificationRow)

// No database or delivery service should be accessed for retired prompts.
const noDB = undefined as unknown as Knex

describe('retired challenge notifications', () => {
  test.each([
    'challenge_reward',
    'claimable_reward',
    'reward_in_cooldown',
    'listen_streak_reminder'
  ])('drops %s from push and digest mapping', (type) => {
    expect(mapNotifications([row(type)], noDB, noDB)).toEqual([])
  })
  test('preserves unrelated and trending announcements in a mixed batch', () => {
    const mapped = mapNotifications(
      [
        row('follow'),
        row('claimable_reward'),
        row('trending'),
        row('trending_underground')
      ],
      noDB,
      noDB
    )
    expect(mapped.map((m) => m!.notification.type)).toEqual([
      'follow',
      'trending',
      'trending_underground'
    ])
  })
})

test('skips a digest containing only retired rewards before rendering or delivery', async () => {
  const sent = await sendNotificationEmail({
    userId: 1,
    email: 'test@example.com',
    frequency: 'daily',
    notifications: [row('claimable_reward'), row('challenge_reward')].map(
      (notification) => ({ ...notification, receiver_user_id: 1 })
    ),
    dnDb: noDB,
    identityDb: noDB
  })
  expect(sent).toBe(false)
  expect(renderEmail).not.toHaveBeenCalled()
  expect(getSendgrid).not.toHaveBeenCalled()
})
