import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@hono/node-server', () => ({
  serve: vi.fn()
}))

const sqlMock = vi.fn(
  (_strings: readonly string[], ..._values: unknown[]) => Promise.resolve([])
) as unknown as (
  strings: readonly string[],
  ...values: unknown[]
) => Promise<unknown[]>

const getUserNormalizedScoreMock = vi.fn()
const getRecentClaimsMock = vi.fn()
const getUserMock = vi.fn()
const getUserScoreMock = vi.fn()
const queryUsersMock = vi.fn()
const recentTipsMock = vi.fn()
const actionLogForUserMock = vi.fn()

vi.mock('../actionLog', () => ({
  sql: sqlMock,
  getUserNormalizedScore: getUserNormalizedScoreMock,
  getRecentClaims: getRecentClaimsMock,
  getUser: getUserMock,
  getUserScore: getUserScoreMock,
  queryUsers: queryUsersMock,
  recentTips: recentTipsMock,
  actionLogForUser: actionLogForUserMock
}))

vi.mock('../identity', () => ({
  useEmail: vi.fn(),
  userFingerprints: vi.fn()
}))

vi.mock('../sdk', () => ({
  getAudiusSdk: vi.fn(() => ({
    users: {
      getUserByHandle: vi.fn(async ({ handle }: { handle: string }) => {
        if (handle === 'unknown') return { data: null }
        return {
          data: {
            id: 'aE07A',
            handle,
            wallet: '0xabc',
            isVerified: false
          }
        }
      })
    }
  }))
}))

vi.mock('../config', () => ({
  config: {
    environment: 'dev',
    discoveryDbConnectionString: '',
    redisUrl: '',
    serverHost: '0.0.0.0',
    serverPort: 6003,
    privateSignerAddress: '00'.repeat(32)
  }
}))

vi.mock('@audius/sdk', () => ({
  HashId: { parse: (s: string) => Number.parseInt(s, 36) || 1 },
  Id: { parse: (n: number) => `HASH-${n}` }
}))

vi.mock('@audius/spl', () => ({
  RewardManagerProgram: {
    encodeAttestation: vi.fn(() => Buffer.from('encoded-attestation'))
  }
}))

vi.mock('keccak256', () => ({
  default: vi.fn(() => Buffer.alloc(32, 1))
}))

vi.mock('secp256k1', () => ({
  ecdsaSign: vi.fn(() => ({ signature: new Uint8Array(64).fill(2), recid: 1 })),
  publicKeyCreate: vi.fn(() => new Uint8Array(65).fill(3))
}))

const setBasicAuthEnv = () => {
  process.env.AAO_AUTH_USER = 'admin'
  process.env.AAO_AUTH_PASSWORD = 'secret'
}

const basicAuthHeader = (user: string, pass: string) =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')

describe('server', () => {
  beforeEach(() => {
    const sqlAsMock = sqlMock as unknown as ReturnType<typeof vi.fn>
    sqlAsMock.mockClear()
    getUserNormalizedScoreMock.mockReset()
    setBasicAuthEnv()
  })

  describe('GET /health_check', () => {
    it('returns 200 with status ok', async () => {
      const { app } = await import('../server')
      const res = await app.request('/health_check')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        status: 'ok',
        antiAbuseWalletPubkey: expect.any(String)
      })
    })
  })

  describe('GET /attestation/check', () => {
    it('returns 400 when wallet query param is missing', async () => {
      const { app } = await import('../server')
      const res = await app.request('/attestation/check')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'wallet is required' })
    })

    it('returns 404 when wallet is not found', async () => {
      const sqlAsMock = sqlMock as unknown as ReturnType<typeof vi.fn>
      sqlAsMock.mockImplementationOnce(() => Promise.resolve([]))
      const { app } = await import('../server')
      const res = await app.request('/attestation/check?wallet=0xDEAD')
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'wallet not found: 0xDEAD' })
    })

    it('returns "blocked" when overall score is negative', async () => {
      const sqlAsMock = sqlMock as unknown as ReturnType<typeof vi.fn>
      sqlAsMock.mockImplementationOnce(() =>
        Promise.resolve([{ user_id: 1, wallet: '0xabc' }])
      )
      getUserNormalizedScoreMock.mockResolvedValueOnce({ overallScore: -50 })

      const { app } = await import('../server')
      const res = await app.request('/attestation/check?wallet=0xABC')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ data: 'blocked' })
      expect(getUserNormalizedScoreMock).toHaveBeenCalledWith(1, '0xabc')
    })

    it('returns "allowed" when overall score is non-negative', async () => {
      const sqlAsMock = sqlMock as unknown as ReturnType<typeof vi.fn>
      sqlAsMock.mockImplementationOnce(() =>
        Promise.resolve([{ user_id: 2, wallet: '0xabc' }])
      )
      getUserNormalizedScoreMock.mockResolvedValueOnce({ overallScore: 42 })

      const { app } = await import('../server')
      const res = await app.request('/attestation/check?wallet=0xABC')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ data: 'allowed' })
    })

    it('lowercases the wallet before querying', async () => {
      const sqlSpy = sqlMock as unknown as ReturnType<typeof vi.fn>
      sqlSpy.mockImplementationOnce(
        (_strings: readonly string[], ...values: unknown[]) => {
          expect(values).toEqual(['0xabc'])
          return Promise.resolve([{ user_id: 3, wallet: '0xabc' }])
        }
      )
      getUserNormalizedScoreMock.mockResolvedValueOnce({ overallScore: 1 })

      const { app } = await import('../server')
      const res = await app.request('/attestation/check?wallet=0xABC')
      expect(res.status).toBe(200)
    })
  })

  describe('POST /attestation/block-user', () => {
    it('requires basic auth', async () => {
      const { app } = await import('../server')
      const body = new URLSearchParams({ handle: 'spammer' })
      const res = await app.request('/attestation/block-user', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body
      })
      expect(res.status).toBe(401)
    })

    it('returns 400 when handle is missing in form body', async () => {
      const { app } = await import('../server')
      const res = await app.request('/attestation/block-user', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basicAuthHeader('admin', 'secret')
        },
        body: new URLSearchParams()
      })
      expect(res.status).toBe(400)
      expect(await res.text()).toBe('Handle is required')
    })

    it('redirects after a successful block', async () => {
      const sqlAsMock = sqlMock as unknown as ReturnType<typeof vi.fn>
      sqlAsMock.mockImplementationOnce(() => Promise.resolve([]))
      const { app } = await import('../server')
      const res = await app.request('/attestation/block-user', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basicAuthHeader('admin', 'secret')
        },
        body: new URLSearchParams({ handle: 'Spammer' })
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(
        '/attestation/ui/user?q=Spammer'
      )
    })
  })

  describe('POST /attestation/:handle', () => {
    it('returns 404 when the handle is not found in the SDK', async () => {
      const { app } = await import('../server')
      const res = await app.request('/attestation/unknown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'dvl',
          challengeSpecifier: 'spec',
          amount: 1
        })
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'handle not found: unknown' })
    })

    it('denies a verified-only reward when the user is not verified', async () => {
      const { app } = await import('../server')
      const res = await app.request('/attestation/anyone', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'u',
          challengeSpecifier: 'spec',
          amount: 1
        })
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'denied' })
    })
  })
})
