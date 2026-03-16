import type { App } from '@pedalboard/basekit'
import type { SharedData } from './config'
import { auditVersions } from './audits/version'
import { propose } from './proposal'

export async function audit (app: App<SharedData>): Promise<void> {
  const { libs } = app.viewAppData()
  const db = app.getDnDb()
  const discoveryNodes =
    (await libs.ServiceProvider?.listDiscoveryProviders()) ?? []
  const contentNodes =
    (await libs.ServiceProvider?.listCreatorNodes()) ?? []
  const minVersions =
    (await libs.ethContracts?.getExpectedServiceVersions()) ?? {}
  const proposals = await auditVersions(
    db,
    discoveryNodes,
    contentNodes,
    minVersions
  )
  for (const proposal of proposals) {
    await propose(app, proposal)
  }
}
