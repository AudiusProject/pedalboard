import { getContentNode } from '../utils/env'
import { formatImageUrl } from '../utils/format'

describe('content node env', () => {
  const oldNotificationsEndpoint =
    process.env.NOTIFICATIONS_CONTENT_NODE_ENDPOINT
  const oldContentEndpoint = process.env.CONTENT_NODE_ENDPOINT

  afterEach(() => {
    if (oldNotificationsEndpoint === undefined) {
      delete process.env.NOTIFICATIONS_CONTENT_NODE_ENDPOINT
    } else {
      process.env.NOTIFICATIONS_CONTENT_NODE_ENDPOINT = oldNotificationsEndpoint
    }

    if (oldContentEndpoint === undefined) {
      delete process.env.CONTENT_NODE_ENDPOINT
    } else {
      process.env.CONTENT_NODE_ENDPOINT = oldContentEndpoint
    }
  })

  it('uses the API content gateway by default', () => {
    delete process.env.NOTIFICATIONS_CONTENT_NODE_ENDPOINT
    delete process.env.CONTENT_NODE_ENDPOINT

    expect(getContentNode()).toBe('https://api.audius.co')
    expect(formatImageUrl('image-cid', 150)).toBe(
      'https://api.audius.co/content/image-cid/150x150.jpg'
    )
  })

  it('allows notification-specific gateway overrides', () => {
    process.env.NOTIFICATIONS_CONTENT_NODE_ENDPOINT =
      'https://images.example.com/'
    process.env.CONTENT_NODE_ENDPOINT = 'https://generic.example.com'

    expect(getContentNode()).toBe('https://images.example.com')
  })
})
