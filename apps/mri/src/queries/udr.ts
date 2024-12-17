import { Knex } from 'knex'
import { logger as plogger } from '../logger'
import { toCsvString } from '../csv'
import { S3Config, publish } from '../s3'
import { readConfig } from '../config'
import dayjs from 'dayjs'
import quarterOfYear from 'dayjs/plugin/quarterOfYear'
import { formatDateISO, getYearMonthShorthand } from '../date'

dayjs.extend(quarterOfYear)

const config = readConfig()

type UsageDetailReporting = {
  client_catalog_id: number
  Offering: 'Downloads / Monetized Content' | 'Subscription'
  Streams: number
  Downloads: number
  Territory: string
}

const UsageDetailReportingHeader: (keyof UsageDetailReporting)[] = [
  'client_catalog_id',
  'Offering',
  'Streams',
  'Downloads',
  'Territory'
]

// gathers data from a month prior to the provided date.
// formats it into csv format compatible with the mri spec
// publishes it to all the provided s3 configs
export const udr = async (
  db: Knex,
  s3s: S3Config[],
  date: Date
): Promise<void> => {
  const logger = plogger.child({ date: date.toISOString() })
  logger.info('beginning usage detail report processing')
  const startOfThisMonth = dayjs(date).startOf('month')
  const startOfLastMonth = startOfThisMonth.subtract(1, 'month')

  const start = startOfLastMonth.toDate()
  const end = startOfThisMonth.toDate()

  logger.info(
    { start: start.toISOString(), end: end.toISOString() },
    'time range'
  )

  const queryResult = await db.raw(
    `
    select
      coalesce(t1.client_catalog_id, t2.client_catalog_id) as "client_catalog_id",
      'Downloads / Monetized Content' as "Offering",
      'Free Trial' as "UserType",
      coalesce(t1."Streams", 0) as "Streams",
      coalesce(t2."Downloads", 0) as "Downloads",
      coalesce(nullif(country_to_iso_alpha2(coalesce(t1."Territory", t2."Territory", '')), ''), 'WW') as "Territory",
      coalesce((tracks.download_conditions->'usdc_purchase'->>'price')::float/100, 0.0) as "Price Point"
    from (
      select
        "play_item_id" as "client_catalog_id",
        sum("count") as "Streams",
        "country" as "Territory"
      from
        "aggregate_monthly_plays"
      where
        "timestamp" >= :start and
        "timestamp" < :end
      group by "country", "play_item_id"
    ) t1
    full outer join (
      select
        "parent_track_id" as "client_catalog_id",
        count(*) as "Downloads",
        "country" as "Territory"
      from
        "track_downloads"
      where
        "created_at" >= :start and
        "created_at" < :end
      group by "country", "parent_track_id"
    ) t2
    on t1.client_catalog_id = t2.client_catalog_id and (t1."Territory" = t2."Territory" or t2."Territory" = '')
    join tracks on t1.client_catalog_id = tracks.track_id
    `,
    { start, end }
  )

  const udrRows: UsageDetailReporting[] = queryResult.rows
  const csv = toCsvString(udrRows, UsageDetailReportingHeader)
  const now = new Date()
  // Audius_Usage_YYMM_YYYYMMDDhhmmss.csv
  // YYMM = Year and Month of usage, YYYYMMDDhhmmss = time of generation
  const fileName = `Audius_Usage_${getYearMonthShorthand(
    start
  )}_${formatDateISO(now)}`

  const results = await publish(logger, s3s, csv, fileName)
  results.forEach((objUrl) =>
    logger.info({ objUrl, records: udrRows.length }, 'upload result')
  )
}
