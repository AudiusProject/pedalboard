// Request credentials must never reach the logs. Signed download URLs carry
// the caller's wallet signature as query params, and every archiver request
// arrives with cookies and the encoded-data-* signature headers. All of these
// are bearer credentials: anyone who can read the logs can replay them until
// they expire.

export const REDACTED = 'REDACTED'

const SENSITIVE_QUERY_PARAMS = ['user_signature', 'user_data', 'api_key']

// Allowlist rather than denylist, so a new credential-bearing header doesn't
// leak just because nobody thought to add it here.
const LOGGABLE_HEADERS = [
  'host',
  'user-agent',
  'accept',
  'content-type',
  'content-length',
  'origin',
  'x-forwarded-for',
  'cf-connecting-ip',
  'cf-ray',
  'x-request-id'
]

const isAbsoluteUrl = (url: string) => /^[a-z][a-z\d+.-]*:/i.test(url)

/**
 * Replaces the values of credential query params in a URL. Accepts both
 * absolute URLs and path-only request URLs (e.g. `/archive/stems/1?x=y`).
 */
export const redactUrl = (url: string): string => {
  let parsed: URL
  try {
    parsed = new URL(url, 'http://localhost')
  } catch {
    // Can't tell what's in it, so don't log any of it.
    return REDACTED
  }
  for (const param of SENSITIVE_QUERY_PARAMS) {
    if (parsed.searchParams.has(param)) {
      parsed.searchParams.set(param, REDACTED)
    }
  }
  return isAbsoluteUrl(url)
    ? parsed.toString()
    : `${parsed.pathname}${parsed.search}${parsed.hash}`
}

const redactQuery = (query: unknown) => {
  if (!query || typeof query !== 'object') return query
  const redacted: Record<string, unknown> = { ...query }
  for (const param of SENSITIVE_QUERY_PARAMS) {
    if (param in redacted) {
      redacted[param] = REDACTED
    }
  }
  return redacted
}

const pickLoggableHeaders = (headers: Record<string, unknown> | undefined) => {
  const picked: Record<string, unknown> = {}
  for (const name of LOGGABLE_HEADERS) {
    if (headers?.[name] !== undefined) {
      picked[name] = headers[name]
    }
  }
  return picked
}

type SerializedRequest = {
  url?: string
  query?: unknown
  headers?: Record<string, unknown>
}

/**
 * pino-http `req` serializer. Receives pino's already-serialized request, so
 * reassigning fields here never touches the live request object.
 */
export const redactRequest = <T extends SerializedRequest>(req: T): T => {
  if (typeof req.url === 'string') {
    req.url = redactUrl(req.url)
  }
  req.query = redactQuery(req.query)
  req.headers = pickLoggableHeaders(req.headers)
  return req
}
