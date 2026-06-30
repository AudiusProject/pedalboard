export const getEnv = (): 'prod' => {
  return 'prod'
}

export const getHostname = () => {
  return 'https://audius.co'
}

const DEFAULT_CONTENT_NODE = 'https://api.audius.co'

export const getContentNode = () => {
  return (
    process.env.NOTIFICATIONS_CONTENT_NODE_ENDPOINT ||
    process.env.CONTENT_NODE_ENDPOINT ||
    DEFAULT_CONTENT_NODE
  ).replace(/\/+$/, '')
}
