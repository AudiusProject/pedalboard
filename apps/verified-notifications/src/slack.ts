import { WebClient } from '@slack/web-api'

const formatter = (data: Record<string, unknown>): string => {
  const msg: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (value != null) {
      msg.push(`${key}: ${value}`)
    }
  }
  return '```' + msg.join('\n') + '```'
}

const Slack = () => {
  const { SLACK_TOKEN } = process.env
  const web = new WebClient(SLACK_TOKEN!)
  return {
    sendMsg: (channel: string, header: string, body: Record<string, unknown>) => {
      const msg = `${header} ${formatter(body)}`
      return web.chat.postMessage({ text: msg, channel })
    }
  }
}

export const slack = Slack()
