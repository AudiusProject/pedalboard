import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('dotenv', () => ({
  default: { config: vi.fn(() => ({ parsed: {} })) },
  config: vi.fn(() => ({ parsed: {} }))
}))

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))

const AAO_ENV_KEYS = [
  'audius_discprov_env',
  'audius_discprov_url',
  'audius_db_url',
  'audius_redis_url',
  'anti_abuse_oracle_server_host',
  'anti_abuse_oracle_server_port',
  'private_signer_address'
] as const

describe('config', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of AAO_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    vi.resetModules()
  })

  afterEach(() => {
    for (const key of AAO_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
  })

  it('exposes defaults when no env vars are set', async () => {
    const mod = await import('../config')
    const cfg = mod.readConfig()
    expect(cfg.environment).toBe('dev')
    expect(cfg.discoveryDbConnectionString).toBe(
      'postgresql+psycopg2://postgres:postgres@db:5432/discovery_provider_1'
    )
    expect(cfg.redisUrl).toBe('redis://audius-discovery-redis-1:6379/00')
    expect(cfg.serverHost).toBe('0.0.0.0')
    expect(cfg.serverPort).toBe(6003)
    expect(cfg.privateSignerAddress).toBe('')
  })

  it('parses environment variables into Config', async () => {
    process.env.audius_discprov_env = 'prod'
    process.env.audius_db_url = 'postgres://test-db'
    process.env.audius_redis_url = 'redis://test-redis'
    process.env.anti_abuse_oracle_server_host = '127.0.0.1'
    process.env.anti_abuse_oracle_server_port = '8080'
    process.env.private_signer_address = 'abc123'

    const mod = await import('../config')
    const cfg = mod.readConfig()
    expect(cfg.environment).toBe('prod')
    expect(cfg.discoveryDbConnectionString).toBe('postgres://test-db')
    expect(cfg.redisUrl).toBe('redis://test-redis')
    expect(cfg.serverHost).toBe('127.0.0.1')
    expect(cfg.serverPort).toBe(8080)
    expect(cfg.privateSignerAddress).toBe('abc123')
  })

  it('coerces server port to a number', async () => {
    process.env.anti_abuse_oracle_server_port = '4242'
    const mod = await import('../config')
    const cfg = mod.readConfig()
    expect(cfg.serverPort).toBe(4242)
    expect(typeof cfg.serverPort).toBe('number')
  })

  it('caches config after first call', async () => {
    process.env.audius_discprov_env = 'dev'
    const mod = await import('../config')
    const first = mod.readConfig()
    process.env.audius_discprov_env = 'prod'
    const second = mod.readConfig()
    expect(second).toBe(first)
    expect(second.environment).toBe('dev')
  })

  it('exports Solana sysvar PublicKeys for clock and instructions', async () => {
    const mod = await import('../config')
    expect(mod.ClockProgram.toBase58()).toBe(
      'SysvarC1ock11111111111111111111111111111111'
    )
    expect(mod.InstructionsProgram.toBase58()).toBe(
      'Sysvar1nstructions1111111111111111111111111'
    )
  })

  it('exports listens rate limit prefix constants', async () => {
    const mod = await import('../config')
    expect(mod.LISTENS_RATE_LIMIT_IP_PREFIX).toBe('listens-rate-limit-ip')
    expect(mod.LISTENS_RATE_LIMIT_TRACK_PREFIX).toBe('listens-rate-limit-track')
  })
})
