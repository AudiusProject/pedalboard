import type { App } from '@pedalboard/basekit'
import type { SharedData } from './config'

export const VERSION_DATA_TABLE_NAME = 'sla_auditor_version_data'

export async function createTables (app: App<SharedData>): Promise<void> {
  const db = app.getDnDb()
  const exists = await db.schema.hasTable(VERSION_DATA_TABLE_NAME)
  if (!exists) {
    await db.schema.createTable(VERSION_DATA_TABLE_NAME, (table) => {
      table.increments('id').primary()
      table.string('nodeEndpoint').notNullable().index()
      table.string('nodeVersion').notNullable()
      table.string('minVersion').notNullable()
      table.string('owner').notNullable()
      table.boolean('ok').notNullable()
      table.timestamp('timestamp').defaultTo(db.fn.now())
    })
  }
}
