import 'dotenv/config'

import postgres from 'postgres'

export const sql = postgres(process.env.IDENTITY_DB_URL || '')

type FingerprintCount = {
  fingerprint: string
  userCount: number
  userIds: number[]
}

export async function userFingerprints(userId: number) {
  const rows: FingerprintCount[] = await sql`
    select
      "visitorId" as "fingerprint",
      count(distinct "userId") as "userCount",
      array_agg("userId") as "userIds"
    from "Fingerprints"
    where "visitorId" in (
      select "visitorId" from "Fingerprints" where "userId" = ${userId}
    )
    group by 1 order by 2 desc limit 90;
  `

  for (const row of rows) {
    row.userIds.sort()
  }

  return rows
}

export async function useFingerprintDeviceCount(userId: number) {
  const rows = await sql`
    SELECT
        MAX("userCount") AS "maxUserCount"
    FROM (
        SELECT
            "visitorId",
            COUNT(DISTINCT "userId") AS "userCount"
        FROM "Fingerprints"
        WHERE "visitorId" IN (
            SELECT "visitorId" FROM "Fingerprints" WHERE "userId" = ${userId}
        )
        GROUP BY "visitorId"
    ) t;
  `
  console.log('asdf rows: ', rows)
  return rows[0].maxUserCount ?? 0
}
