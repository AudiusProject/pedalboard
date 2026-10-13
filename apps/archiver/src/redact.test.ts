import http from 'http'
import { AddressInfo } from 'net'
import pinoHttp from 'pino-http'
import { Writable } from 'stream'
import { describe, expect, it } from 'vitest'

import { REDACTED, redactRequest, redactUrl } from './redact'

describe('redactUrl', () => {
  it('redacts credential params in an absolute URL and keeps the rest', () => {
    const redacted = redactUrl(
      'https://api.audius.co/v1/tracks/abc/download?user_id=7&user_signature=0xsig&user_data=signature%3A123&filename=a.wav'
    )
    const parsed = new URL(redacted)
    expect(parsed.origin + parsed.pathname).toBe(
      'https://api.audius.co/v1/tracks/abc/download'
    )
    expect(parsed.searchParams.get('user_id')).toBe('7')
    expect(parsed.searchParams.get('filename')).toBe('a.wav')
    expect(parsed.searchParams.get('user_signature')).toBe(REDACTED)
    expect(parsed.searchParams.get('user_data')).toBe(REDACTED)
    expect(redacted).not.toContain('0xsig')
    expect(redacted).not.toContain('signature%3A123')
  })

  it('redacts api_key', () => {
    expect(redactUrl('https://x.test/a?api_key=secret')).not.toContain(
      'secret'
    )
  })

  it('keeps path-only URLs path-only', () => {
    expect(redactUrl('/archive/stems/abc?user_id=1&user_signature=s')).toBe(
      `/archive/stems/abc?user_id=1&user_signature=${REDACTED}`
    )
  })

  it('leaves URLs without credentials unchanged', () => {
    expect(redactUrl('https://x.test/a/b?c=d')).toBe('https://x.test/a/b?c=d')
    expect(redactUrl('/archive/stems/job/1')).toBe('/archive/stems/job/1')
  })
})

describe('redactRequest', () => {
  const serialize = () => ({
    id: 1,
    method: 'GET',
    url: '/archive/stems/job/1?user_signature=0xsig',
    query: { user_id: '7', user_signature: '0xsig' },
    headers: {
      host: 'archiver.audius.co',
      'user-agent': 'test',
      cookie: 'cf_clearance=abc; AMP_123=def',
      'encoded-data-message': 'signature:123',
      'encoded-data-signature': '0xsig',
      authorization: 'Bearer token'
    }
  })

  it('logs only allowlisted headers', () => {
    expect(redactRequest(serialize()).headers).toEqual({
      host: 'archiver.audius.co',
      'user-agent': 'test'
    })
  })

  it('redacts credentials in the url and query', () => {
    const req = redactRequest(serialize())
    expect(JSON.stringify(req)).not.toContain('0xsig')
    expect(req.query).toEqual({ user_id: '7', user_signature: REDACTED })
  })

  it('does not mutate the query object it was given', () => {
    const serialized = serialize()
    const { query } = serialized
    redactRequest(serialized)
    expect(query.user_signature).toBe('0xsig')
  })
})

describe('pino-http with redactRequest', () => {
  it('keeps credentials out of the request log line', async () => {
    const lines: string[] = []
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString())
        callback()
      }
    })
    const httpLogger = pinoHttp(
      { serializers: { req: redactRequest } },
      destination
    )
    const server = http.createServer((req, res) => {
      httpLogger(req, res)
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const { port } = server.address() as AddressInfo

    try {
      await new Promise<void>((resolve, reject) => {
        http
          .get(
            {
              port,
              path: '/archive/stems/job/1?user_id=7&user_signature=0xsig',
              headers: {
                cookie: 'cf_clearance=abc',
                'encoded-data-message': 'signature:123',
                'encoded-data-signature': '0xsig'
              }
            },
            (res) => {
              res.resume()
              res.on('end', resolve)
            }
          )
          .on('error', reject)
      })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }

    const logged = lines.join('')
    expect(logged).toContain('/archive/stems/job/1')
    expect(logged).not.toContain('0xsig')
    expect(logged).not.toContain('cf_clearance')
    expect(logged).not.toContain('signature:123')
  })
})
