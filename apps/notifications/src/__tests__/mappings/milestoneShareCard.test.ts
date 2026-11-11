import { expect, test } from '@jest/globals'
import { Knex } from 'knex'

import { Milestone } from '../../processNotifications/mappers/milestone'
import { MilestoneType } from '../../types/notifications'

const makeMilestone = (type: MilestoneType, threshold: number) =>
  new Milestone(
    null as unknown as Knex,
    null as unknown as Knex,
    {
      user_ids: [1],
      group_id: `milestone:${type}:id:2:threshold:${threshold}`,
      data: { type, threshold, track_id: 2 }
    } as unknown as ConstructorParameters<typeof Milestone>[2]
  )

describe('Milestone share card', () => {
  test.each([1000, 5000, 10000, 50000, 100000, 500000, 1000000])(
    'flags the push at %i plays',
    (threshold) => {
      const milestone = makeMilestone(MilestoneType.LISTEN_COUNT, threshold)
      expect(milestone.getPushData()).toEqual({
        type: 'MilestoneListen',
        entityId: '2',
        actions: [{ actionEntityType: 'Track' }],
        shareCard: true,
        threshold
      })
      expect(milestone.getPushBodyText('song')).toBe(
        `song just hit ${threshold.toLocaleString()} plays. Share it`
      )
    }
  )

  test.each([10, 25, 50, 100, 250, 500, 2500, 25000, 250000])(
    'keeps the plain push at %i plays',
    (threshold) => {
      const milestone = makeMilestone(MilestoneType.LISTEN_COUNT, threshold)
      expect(milestone.getPushData()).toEqual({
        type: 'MilestoneListen',
        entityId: '2',
        actions: [{ actionEntityType: 'Track' }]
      })
      expect(milestone.getPushBodyText('song')).toBe(
        `Your track song has reached over ${threshold.toLocaleString()} listens`
      )
    }
  )

  test.each([MilestoneType.TRACK_REPOST_COUNT, MilestoneType.TRACK_SAVE_COUNT])(
    'keeps the plain push for %s',
    (type) => {
      const data = makeMilestone(type, 1000).getPushData()
      expect(data).not.toHaveProperty('shareCard')
    }
  )
})
