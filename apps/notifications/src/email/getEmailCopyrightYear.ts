/**
 * Email footers show the current calendar year. In Jest, set
 * NOTIFICATIONS_EMAIL_COPYRIGHT_YEAR so HTML snapshots don’t change every January.
 */
export function getEmailCopyrightYear(): string {
  const fixed = process.env.NOTIFICATIONS_EMAIL_COPYRIGHT_YEAR
  if (fixed != null && String(fixed).trim() !== '') {
    return String(fixed).trim()
  }
  return String(new Date().getFullYear())
}
