import { describe, it, expect, vi, beforeEach } from 'vitest'
import { personalSign } from 'eth-sig-util'
import { createLogger } from '@pedalboard/logger'
import {
  createUserSignatureVerifier,
  parseSignatureTimestampMs,
  recoverSigner
} from './verifyUserSignature'

// Fixed test keys. Addresses are the deterministic secp256k1 derivations of
// these private keys — hardcoded so the test doesn't need ethereumjs-util,
// which the archiver only pulls in transitively.
const USER_KEY = Buffer.from('11'.repeat(32), 'hex')
const USER_WALLET = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a'
const OTHER_KEY = Buffer.from('22'.repeat(32), 'hex')
const OTHER_WALLET = '0x1563915e194d8cfba1943570603f7606a3115508'

const NOW = 1_785_215_370_374
const message = (ts: number = NOW) => `signature:${ts}`
const sign = (key: Buffer, msg: string) => personalSign(key, { data: msg })

const USER_ID = 8151

const makeVerifier = ({
  user = { ercWallet: USER_WALLET, wallet: USER_WALLET } as unknown,
  getUser,
  signatureMaxAgeSeconds = 3600
}: {
  user?: unknown
  getUser?: ReturnType<typeof vi.fn>
  signatureMaxAgeSeconds?: number
} = {}) => {
  const getUserMock =
    getUser ?? vi.fn().mockResolvedValue({ data: user })
  const sdk = { users: { getUser: getUserMock } }
  const verify = createUserSignatureVerifier({
    // Only `users.getUser` is exercised here.
    sdk: sdk as never,
    config: { signatureMaxAgeSeconds } as never,
    logger: createLogger('verifyUserSignature-test')
  })
  return { verify, getUserMock }
}

describe('parseSignatureTimestampMs', () => {
  it('reads the timestamp out of a well-formed message', () => {
    expect(parseSignatureTimestampMs('signature:1785215370374')).toBe(
      1785215370374
    )
  })

  it('rejects messages that are not in signature:<ms> form', () => {
    expect(parseSignatureTimestampMs('1785215370374')).toBeNull()
    expect(parseSignatureTimestampMs('signature:')).toBeNull()
    expect(parseSignatureTimestampMs('signature:not-a-number')).toBeNull()
    expect(parseSignatureTimestampMs('')).toBeNull()
  })
})

describe('recoverSigner', () => {
  it('recovers the signing wallet', () => {
    const msg = message()
    expect(recoverSigner(msg, sign(USER_KEY, msg))).toBe(USER_WALLET)
  })

  it('returns null for a malformed signature rather than throwing', () => {
    // This is the literal payload that got a job enqueued before this existed.
    expect(recoverSigner(message(), '0xdeadbeef')).toBeNull()
    expect(recoverSigner(message(), '')).toBeNull()
    expect(recoverSigner(message(), 'not-hex')).toBeNull()
  })

  it('does not recover the signer when the message is altered', () => {
    const sig = sign(USER_KEY, message())
    expect(recoverSigner(message(NOW + 1), sig)).not.toBe(USER_WALLET)
  })
})

describe('createUserSignatureVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts a signature from the claimed user', async () => {
    const { verify } = makeVerifier()
    const msg = message()

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result).toEqual({ ok: true, wallet: USER_WALLET })
  })

  it('rejects a garbage signature without ever looking up the user', async () => {
    // The reported vulnerability: `0xdeadbeef` was accepted and enqueued a job.
    const { verify, getUserMock } = makeVerifier()

    const result = await verify({
      userId: USER_ID,
      messageHeader: message(),
      signatureHeader: '0xdeadbeef',
      now: NOW
    })

    expect(result).toEqual({
      ok: false,
      reason: 'signature could not be recovered'
    })
    // Cheap local checks must short-circuit before we spend an API call.
    expect(getUserMock).not.toHaveBeenCalled()
  })

  it('rejects a valid signature from a wallet that is not the claimed user', async () => {
    const { verify } = makeVerifier()
    const msg = message()

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(OTHER_KEY, msg),
      now: NOW
    })

    expect(result).toEqual({
      ok: false,
      reason: 'signature does not match user'
    })
  })

  it('rejects a malformed message', async () => {
    const { verify, getUserMock } = makeVerifier()

    const result = await verify({
      userId: USER_ID,
      messageHeader: 'gimme the stems',
      signatureHeader: sign(USER_KEY, 'gimme the stems'),
      now: NOW
    })

    expect(result).toEqual({
      ok: false,
      reason: 'malformed signature message'
    })
    expect(getUserMock).not.toHaveBeenCalled()
  })

  it('rejects a signature older than the max age', async () => {
    const { verify } = makeVerifier({ signatureMaxAgeSeconds: 60 })
    const msg = message(NOW - 61_000)

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result).toEqual({
      ok: false,
      reason: 'signature timestamp outside accepted window'
    })
  })

  it('rejects a signature dated too far in the future', async () => {
    const { verify } = makeVerifier({ signatureMaxAgeSeconds: 60 })
    const msg = message(NOW + 61_000)

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result.ok).toBe(false)
  })

  it('accepts a skewed clock inside the window', async () => {
    const { verify } = makeVerifier({ signatureMaxAgeSeconds: 3600 })
    const msg = message(NOW - 600_000) // 10 minutes fast

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result.ok).toBe(true)
  })

  it('skips the age check when max age is 0', async () => {
    const { verify } = makeVerifier({ signatureMaxAgeSeconds: 0 })
    const msg = message(NOW - 90 * 24 * 60 * 60 * 1000)

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result.ok).toBe(true)
  })

  it('matches on wallet when ercWallet is absent', async () => {
    const { verify } = makeVerifier({ user: { wallet: USER_WALLET } })
    const msg = message()

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result.ok).toBe(true)
  })

  it('is case-insensitive about the stored wallet', async () => {
    const { verify } = makeVerifier({
      user: { ercWallet: USER_WALLET.toUpperCase().replace('0X', '0x') }
    })
    const msg = message()

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result.ok).toBe(true)
  })

  it('rejects when the user has no wallet on record', async () => {
    const { verify } = makeVerifier({ user: { ercWallet: '', wallet: '' } })
    const msg = message()

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result).toEqual({
      ok: false,
      reason: 'user has no wallet on record'
    })
  })

  it('rejects when the user does not exist', async () => {
    // Set via getUser rather than `user: undefined` — a default parameter
    // would swallow that and hand back the happy-path user.
    const { verify } = makeVerifier({
      getUser: vi.fn().mockResolvedValue({ data: undefined })
    })
    const msg = message()

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result).toEqual({ ok: false, reason: 'user not found' })
  })

  it('distinguishes an API failure from a bad signature', async () => {
    // The route turns this into a 503, not a 401 — a discovery outage must not
    // look to the user like their credentials are wrong.
    const { verify } = makeVerifier({
      getUser: vi.fn().mockRejectedValue(new Error('502 Bad Gateway'))
    })
    const msg = message()

    const result = await verify({
      userId: USER_ID,
      messageHeader: msg,
      signatureHeader: sign(USER_KEY, msg),
      now: NOW
    })

    expect(result).toEqual({ ok: false, reason: 'user lookup failed' })
  })
})
