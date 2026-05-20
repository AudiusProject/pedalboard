import { Knex } from 'knex'

import { logger } from '../../logger'
import {
  getWelcomeEmail,
  type WelcomeFeaturedTrack
} from './preRendered/welcome'
import { sendTransactionalEmail } from './sendEmail'

// Node 18+ exposes `fetch` as a global (apps/notifications/Dockerfile
// pins `node:18.16-alpine`), but @types/node@17.0.29 in this workspace
// doesn't type it yet. Declare the slice we actually use here rather
// than pulling `lib: ["dom"]` into every file in the service.
declare const fetch: (input: string) => Promise<{
  ok: boolean
  status: number
  statusText: string
  json: () => Promise<unknown>
}>

// Default REST endpoint to fetch trending tracks for the "Featured on
// Audius" section. Override via DISCOVERY_PROVIDER_URL when running
// against a custom DN. The template is null-safe per slot, so a
// fetch failure just hides the artwork.
const DEFAULT_DISCOVERY_PROVIDER_URL = 'https://discoveryprovider.audius.co'

type IdentityUserRow = {
  id: number
  email: string | null
  walletAddress: string | null
  handle: string | null
  isEmailDeliverable: boolean | null
  isBlockedFromEmails: boolean | null
}

const fetchIdentityUserById = async (
  identityDb: Knex,
  userId: number
): Promise<IdentityUserRow | null> => {
  const row = await identityDb<IdentityUserRow>('Users')
    .select(
      'id',
      'email',
      'walletAddress',
      'handle',
      'isEmailDeliverable',
      'isBlockedFromEmails'
    )
    .where({ id: userId })
    .first()
  return row ?? null
}

const fetchFeaturedTrendingTracks = async (): Promise<
  WelcomeFeaturedTrack[]
> => {
  const baseUrl =
    process.env.DISCOVERY_PROVIDER_URL?.replace(/\/$/, '') ||
    DEFAULT_DISCOVERY_PROVIDER_URL
  const url = `${baseUrl}/v1/full/tracks/trending?limit=3&offset=0&time=month`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      logger.warn(
        `welcomeEmail: trending fetch ${res.status} ${res.statusText}`
      )
      return []
    }
    const json = (await res.json()) as { data?: WelcomeFeaturedTrack[] }
    return json?.data ?? []
  } catch (e) {
    logger.warn(`welcomeEmail: trending fetch failed ${(e as Error).message}`)
    return []
  }
}

const recordHasSignedInNativeMobile = async (
  identityDb: Knex,
  walletAddress: string,
  hasSignedInNativeMobile: boolean
) => {
  // Same upsert identity-service did at /email/welcome — the dashboard
  // and signup analytics rely on this flag landing in UserEvents.
  await identityDb.raw(
    `
    INSERT INTO "UserEvents" ("walletAddress", "hasSignedInNativeMobile", "createdAt", "updatedAt")
    VALUES (:walletAddress, :hasSignedInNativeMobile, now(), now())
    ON CONFLICT ("walletAddress")
    DO UPDATE SET "hasSignedInNativeMobile" = :hasSignedInNativeMobile;
    `,
    { walletAddress, hasSignedInNativeMobile }
  )
}

export type SendWelcomeEmailArgs = {
  identityDb: Knex
  /** blockchainUserId of the new user (Users.id in identity DB). */
  userId: number
  /** Display name to greet the user with — usually the user's handle. */
  name: string
  /** Was this signup completed in the native mobile app? */
  isNativeMobile?: boolean
}

export type SendWelcomeEmailResult =
  | { sent: true }
  | { sent: false; reason: 'no-user' | 'undeliverable' | 'blocked' | 'error' }

/**
 * Send the post-signup welcome email. Trigger semantics match what
 * identity-service /email/welcome did before this lived here:
 *
 * - Skip silently when the user has `isEmailDeliverable = false`
 *   (e.g. signed up with a Privy email we don't deliver to) or
 *   `isBlockedFromEmails = true`.
 * - Best-effort fetch of three trending tracks for the body — a
 *   failed fetch hides the artwork tiles but doesn't block the email.
 * - Mirror the SendGrid envelope identity used: from
 *   "The Audius Team <team@audius.co>", subject "Welcome to Audius! 👋",
 *   asm group 23583 (transactional unsubscribe group, used by other
 *   pedalboard transactional emails).
 * - Upsert UserEvents.hasSignedInNativeMobile so the signup-source
 *   analytics keep working.
 */
export const sendWelcomeEmail = async ({
  identityDb,
  userId,
  name,
  isNativeMobile = false
}: SendWelcomeEmailArgs): Promise<SendWelcomeEmailResult> => {
  const user = await fetchIdentityUserById(identityDb, userId)
  if (!user) {
    logger.info(`welcomeEmail: no identity user for id=${userId}`)
    return { sent: false, reason: 'no-user' }
  }
  if (!user.email) {
    logger.info(`welcomeEmail: missing email for userId=${userId}`)
    return { sent: false, reason: 'undeliverable' }
  }
  if (user.isEmailDeliverable === false) {
    logger.info(
      `welcomeEmail: undeliverable email for handle=${user.handle} (id=${userId})`
    )
    return { sent: false, reason: 'undeliverable' }
  }
  if (user.isBlockedFromEmails === true) {
    logger.info(
      `welcomeEmail: blocked from emails handle=${user.handle} (id=${userId})`
    )
    return { sent: false, reason: 'blocked' }
  }

  const featuredContent = await fetchFeaturedTrendingTracks()
  const copyrightYear = new Date().getFullYear().toString()

  const html = getWelcomeEmail({ name, copyrightYear, featuredContent })

  // Route through sendTransactionalEmail (applies the asm group 23583).
  // We only override `from` so the welcome envelope reads "The Audius
  // Team" instead of the default "Audius". A `false` return indicates a
  // SendGrid failure (logged at error level inside sendTransactionalEmail).
  const sent = await sendTransactionalEmail({
    email: user.email,
    html,
    subject: 'Welcome to Audius! 👋',
    from: 'The Audius Team <team@audius.co>'
  })
  if (!sent) {
    return { sent: false, reason: 'error' }
  }

  if (user.walletAddress) {
    try {
      await recordHasSignedInNativeMobile(
        identityDb,
        user.walletAddress,
        isNativeMobile
      )
    } catch (e) {
      // Don't fail the whole call on the analytics upsert — the email
      // already went out.
      logger.warn(
        `welcomeEmail: UserEvents upsert failed for wallet=${
          user.walletAddress
        }: ${(e as Error).message}`
      )
    }
  }

  logger.info(
    { userId, handle: user.handle, isNativeMobile },
    'welcomeEmail: sent'
  )
  return { sent: true }
}
