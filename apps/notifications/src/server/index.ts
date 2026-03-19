import express, { Express } from 'express'
import { Knex } from 'knex'

import { Server as HttpServer } from 'http'
import { router as healthCheckRouter } from './routes/healthCheck'
import { router as memStatsRouter } from './routes/memStats'
import { createSendAnnouncementRouter } from './routes/sendAnnouncement'

const DEFAULT_PORT = 6000

export class Server {
  app: Express
  port: number
  httpServer: HttpServer

  constructor(port: number = DEFAULT_PORT) {
    this.app = express()
    this.port = port
  }

  init = async (identityDb?: Knex, discoveryDb?: Knex) => {
    this.app.use('/health_check', healthCheckRouter)
    this.app.use('/mem_stats', memStatsRouter)
    if (identityDb && discoveryDb) {
      this.app.use(express.json())
      this.app.use(
        '/internal/send-announcement',
        createSendAnnouncementRouter(discoveryDb)
      )
    }

    await new Promise((resolve) => {
      this.httpServer = this.app.listen(this.port, () => {
        console.log(`server started at http://localhost:${this.port}`)
        resolve(null)
      })
    })
  }

  close = () => {
    this.httpServer?.close()
    console.log('server closed')
  }
}
