import { logger } from './../logger'
import type { ListenerAdapter } from './../listener'
import { AppNotificationsProcessor } from './../processNotifications/indexAppNotifications'

export async function sendAppNotifications(
  listener: ListenerAdapter,
  appNotificationsProcessor: AppNotificationsProcessor
) {
  const pending = listener.takePending()
  if (pending !== undefined) {
    logger.info(
      `Processing ${pending.appNotifications.length} app notifications`
    )

    await appNotificationsProcessor.process(pending.appNotifications)
    logger.info('Processed new app updates')
  }
}
