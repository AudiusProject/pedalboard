import { expect, test, describe } from '@jest/globals'
import { renderNotificationsEmail } from '../email/notifications/components/index'

// These tests exercise the digest renderer directly with pre-formatted
// notification props (no DB needed). They guard the failure modes where a
// single notification in a multi-notification digest could crash the entire
// batch render and silently drop the email.

const baseProps = {
  title: 'Daily Email - test@audius.co',
  subject: '3 unread notifications',
  copyrightYear: '2020'
}

const followProp = {
  type: 'follow',
  users: [{ name: 'user_2', imageUrl: 'http://img/2.jpg' }]
}

const repostProp = {
  type: 'repost',
  users: [{ name: 'user_3', imageUrl: 'http://img/3.jpg' }],
  entity: { type: 'Track', name: 'track_title_10' }
}

describe('Email digest render robustness', () => {
  test('an unmapped notification type does not crash the digest', () => {
    // `usdc_transfer` has no snippet/message handler in the email renderer.
    // Before the fix this threw `snippetMap[notification.type] is not a
    // function` and the whole email silently failed.
    const notifications = [
      followProp,
      { type: 'usdc_transfer' },
      repostProp
    ]
    let html = ''
    expect(() => {
      html = renderNotificationsEmail({ ...baseProps, notifications })
    }).not.toThrow()
    // The mapped notifications still render.
    expect(html).toContain('user_2')
    expect(html).toContain('track_title_10')
  })

  test('a notification with a missing type does not crash the digest', () => {
    const notifications = [followProp, {}, repostProp]
    let html = ''
    expect(() => {
      html = renderNotificationsEmail({ ...baseProps, notifications })
    }).not.toThrow()
    expect(html).toContain('user_2')
  })

  test('a mapped type with missing/null data fields does not crash the digest', () => {
    // `repost` with no `entity` would throw inside the snippet/message handler
    // when reading `entity.type`. It must be skipped, not crash the batch.
    const notifications = [followProp, { type: 'repost', users: [{ name: 'x' }] }]
    let html = ''
    expect(() => {
      html = renderNotificationsEmail({ ...baseProps, notifications })
    }).not.toThrow()
    expect(html).toContain('user_2')
  })

  test('track_added_to_purchased_album renders its content (previously an unhandled gap)', () => {
    const notifications = [
      {
        type: 'track_added_to_purchased_album',
        receiverUserId: { name: 'buyer' },
        playlistOwner: { name: 'artist_1' },
        playlist: { playlist_name: 'My Album' },
        track: { title: 'New Song' }
      }
    ]
    const html = renderNotificationsEmail({ ...baseProps, notifications })
    expect(html).toContain('artist_1')
    expect(html).toContain('New Song')
    expect(html).toContain('on the album you purchased')
    expect(html).toContain('My Album')
  })

  test('a digest of only unmapped notifications renders without crashing', () => {
    const notifications = [
      { type: 'usdc_transfer' },
      { type: 'usdc_withdrawal' },
      { type: 'some_future_type' }
    ]
    let html = ''
    expect(() => {
      html = renderNotificationsEmail({ ...baseProps, notifications })
    }).not.toThrow()
    // Shell still renders (footer/CTA), just no notification cards.
    expect(html).toContain('See more on Audius')
  })
})
