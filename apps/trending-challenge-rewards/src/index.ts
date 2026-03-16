import { log } from '@pedalboard/logger'
import { main } from './main'

;(async () => {
  await main().catch(log)
})()
