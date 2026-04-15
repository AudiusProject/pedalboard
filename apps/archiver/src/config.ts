import 'dotenv/config'
import { cleanEnv, str, num } from 'envalid'

export type Environment = 'dev' | 'prod'

export type LogLevel =
  | 'fatal'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'trace'
  | 'silent'

export type Config = {
  environment: Environment
  /** How often the job to cleanup orphaned files should run (default: 10 seconds) */
  cleanupOrphanedFilesIntervalSeconds: number
  /** How long to keep completed jobs that have not been downloaded (default: 10 minutes) */
  orphanedJobsLifetimeSeconds: number
  /** How many concurrent archive jobs to run (default: 5) */
  concurrentJobs: number
  /** How many attempts to make to create a stems archive (default: 3) */
  maxStemsArchiveAttempts: number
  redisUrl: string
  serverHost: string
  serverPort: number
  /** Temporary directory for storing stems archive files (default: '/tmp/audius-archiver') */
  archiverTmpDir: string
  /** Maximum disk space to use for processing archives (default: 32GB) */
  maxDiskSpaceBytes: number
  /** Maximum time to wait for disk space to be available (default: 60 seconds) */
  maxDiskSpaceWaitSeconds: number
  /** Log level to use for the archiver (default: 'info') */
  logLevel: LogLevel
  /**
   * Developer-app api_key (the app's wallet address) used to identify the
   * archiver to api.audius.co's rate limiter. Attached as `?api_key=<key>`
   * on outbound track/stem fetches so the server resolves the configured
   * app's per-key rps/rpm from the api_keys table instead of the anonymous
   * 5-RPS IP bucket. Public identifier — safe to pass in the URL. Leave
   * unset in dev.
   */
  apiKey?: string
}

let config: Config | null = null

export const readConfig = (): Config => {
  if (config !== null) return config

  const env = cleanEnv(process.env, {
    audius_discprov_env: str<Environment>({
      default: 'dev'
    }),
    audius_redis_url: str({
      default: 'redis://audius-discovery-provider-redis-1:6379/0'
    }),
    archiver_server_host: str({ default: '0.0.0.0' }),
    archiver_server_port: num({ default: 6004 }),
    archiver_concurrent_jobs: num({ default: 5 }),
    archiver_tmp_dir: str({ default: '/tmp/audius-archiver' }),
    archiver_cleanup_orphaned_files_interval_seconds: num({
      default: 10
    }),
    archiver_orphaned_jobs_lifetime_seconds: num({ default: 60 * 10 }),
    archiver_log_level: str<LogLevel>({ default: 'info' }),
    archiver_max_stems_archive_attempts: num({ default: 3 }),
    archiver_max_disk_space_bytes: num({
      default: 32 * 1024 * 1024 * 1024
    }), // 32GB
    archiver_max_disk_space_wait_seconds: num({ default: 60 }),
    audius_archiver_api_key: str({ default: '' })
  })

  config = {
    environment: env.audius_discprov_env,
    concurrentJobs: env.archiver_concurrent_jobs,
    redisUrl: env.audius_redis_url,
    serverHost: env.archiver_server_host,
    serverPort: env.archiver_server_port,
    archiverTmpDir: env.archiver_tmp_dir,
    cleanupOrphanedFilesIntervalSeconds:
      env.archiver_cleanup_orphaned_files_interval_seconds,
    orphanedJobsLifetimeSeconds: env.archiver_orphaned_jobs_lifetime_seconds,
    maxStemsArchiveAttempts: env.archiver_max_stems_archive_attempts,
    maxDiskSpaceBytes: env.archiver_max_disk_space_bytes,
    maxDiskSpaceWaitSeconds: env.archiver_max_disk_space_wait_seconds,
    logLevel: env.archiver_log_level,
    apiKey: env.audius_archiver_api_key || undefined
  }
  return config
}
