import dotenv from 'dotenv'
import { App } from '@pedalboard/basekit'
import { createLogger, log } from '@pedalboard/logger'
import { Server } from './server'
import tracksHandler from './handlers/tracks'
import usersHandler from './handlers/users'
import purchasesHandler from './handlers/purchases'
import artistCoinsHandler from './handlers/artistCoins'

dotenv.config()

const logger = createLogger('verified-notifications')

type AppData = { port: number }

const DEFAULT_PORT = 6000

const shouldToggleOff = (topic: string): boolean => {
  const toggledOffTopics = (process.env.TOGGLE_OFF ?? '').split(',')
  const shouldToggle = toggledOffTopics.includes(topic)
  if (shouldToggle) {
    logger.warn({ topic }, 'toggling off listener for topic')
  }
  return shouldToggle
}

const main = async (): Promise<void> => {
  const port = process.env.port ? parseInt(process.env.port, 10) : DEFAULT_PORT
  const appData: AppData = { port }

  let app = new App<AppData>({ appData })
    .task(async (self) => {
      const server = new Server(self.viewAppData().port)
      await server.init()
    })

  if (!shouldToggleOff('tracks')) app = app.listen('tracks', tracksHandler)
  if (!shouldToggleOff('users')) app = app.listen('users', usersHandler)
  if (!shouldToggleOff('usdc_purchases')) app = app.listen('usdc_purchases', purchasesHandler)
  if (!shouldToggleOff('artist_coins')) app = app.listen('artist_coins', artistCoinsHandler)

  logger.info('verified uploads bot starting')
  await app.run()
}

;(async () => {
  await main().catch(log)
})()
