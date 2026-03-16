import semver from 'semver'
import BN from 'bn.js'
import type { Knex } from 'knex'
import { VERSION_DATA_TABLE_NAME } from '../db'
import { logger } from '../logger'

const SLASH_AMOUNT = 3000
const WEI = new BN('1000000000000000000')
const SLASH_AMOUNT_WEI = new BN(SLASH_AMOUNT).mul(WEI)
const TIME_RANGE_MS = 24 * 60 * 60 * 1000

type NodeWithEndpoint = { endpoint: string; owner: string }
type MinVersions = Record<string, string>
type VersionDataRow = {
  nodeEndpoint: string
  nodeVersion: string
  minVersion: string
  owner: string
  ok: boolean
}

async function getVersionData (
  node: NodeWithEndpoint,
  minVersions: MinVersions,
  nodeType: string
): Promise<VersionDataRow> {
  try {
    const res = await fetch(`${node.endpoint}/health_check`)
    const json = (await res.json()) as { data?: { version?: string; service?: string } }
    const nodeVersion = json.data?.version ?? 'N/A'
    const nodeServiceType = json.data?.service ?? nodeType
    const minVersion = minVersions[nodeServiceType] ?? '0.0.0'
    const nodeMajorVersion = semver.major(nodeVersion)
    const nodeMinorVersion = semver.minor(nodeVersion)
    const minMajorVersion = semver.major(minVersion)
    const minMinorVersion = semver.minor(minVersion)
    const isMajorVersionBehind = nodeMajorVersion < minMajorVersion
    const isMinorVersionBehind =
      nodeMajorVersion === minMajorVersion && nodeMinorVersion < minMinorVersion
    const ok = !isMajorVersionBehind && !isMinorVersionBehind
    return {
      nodeEndpoint: node.endpoint,
      nodeVersion,
      minVersion,
      owner: node.owner,
      ok
    }
  } catch (e) {
    logger.warn({ err: e, endpoint: node.endpoint }, 'Caught error making request to node')
    return {
      nodeEndpoint: node.endpoint,
      nodeVersion: 'N/A',
      minVersion: minVersions[nodeType] ?? '0.0.0',
      owner: node.owner,
      ok: false
    }
  }
}

async function writeVersionData (
  db: Knex,
  versionData: VersionDataRow[]
): Promise<void> {
  await db(VERSION_DATA_TABLE_NAME).insert(versionData)
}

export type ProposalParams = {
  amountWei: BN
  title: string
  description: string
  owner: string
}

function formatProposal (auditResponse: { failedAudit: boolean; data: VersionDataRow }): ProposalParams {
  const { nodeEndpoint, owner, nodeVersion, minVersion } = auditResponse.data
  return {
    amountWei: SLASH_AMOUNT_WEI,
    title: `[SLA] Slash ${SLASH_AMOUNT} $AUDIO from ${owner}`,
    description: `
This proposal presents recommendation to the community to slash ${SLASH_AMOUNT} $AUDIO from
${owner}
for failure to comply with latest chain versions.

SLA: https://docs.audius.org/token/running-a-node/sla#1-minimum-version-guarantee
Endpoint: ${nodeEndpoint}
Node version: ${nodeVersion}
Minimum required version: ${minVersion}
`,
    owner
  }
}

async function audit (
  db: Knex,
  versionData: VersionDataRow
): Promise<{ failedAudit: boolean; data: VersionDataRow }> {
  const now = new Date()
  const before = new Date(now.getTime() - TIME_RANGE_MS)
  const okRow = await db(VERSION_DATA_TABLE_NAME)
    .select('ok')
    .where('nodeEndpoint', versionData.nodeEndpoint)
    .andWhere('timestamp', '>=', before)
    .andWhere('timestamp', '<=', now)
    .andWhere('ok', true)
    .first()
  const hasEnoughData = await db(VERSION_DATA_TABLE_NAME)
    .select('*')
    .where('nodeEndpoint', versionData.nodeEndpoint)
    .andWhere('timestamp', '<=', before)
    .first()
  const failedAudit = Boolean(hasEnoughData && !okRow?.ok)
  return { failedAudit, data: versionData }
}

export async function auditVersions (
  db: Knex,
  discoveryNodes: NodeWithEndpoint[],
  contentNodes: NodeWithEndpoint[],
  minVersions: MinVersions
): Promise<ProposalParams[]> {
  const versionDataDiscovery = await Promise.all(
    discoveryNodes.map((node) =>
      getVersionData(node, minVersions, 'discovery-node')
    )
  )
  const versionDataContent = await Promise.all(
    contentNodes.map((node) =>
      getVersionData(node, minVersions, 'content-node')
    )
  )
  const versionData = [...versionDataDiscovery, ...versionDataContent]
  await writeVersionData(db, versionData)
  const auditResponses = await Promise.all(
    versionData.map((data) => audit(db, data))
  )
  for (const a of auditResponses) {
    const status = a.failedAudit ? '[FAILED]' : '[PASS]'
    logger.info(
      { endpoint: a.data.nodeEndpoint, nodeVersion: a.data.nodeVersion, minVersion: a.data.minVersion },
      `${status} ${a.data.nodeEndpoint} has version ${a.data.nodeVersion}, min version: ${a.data.minVersion}`
    )
  }
  const failedAudits = auditResponses.filter((r) => r.failedAudit)
  return failedAudits.map((r) => formatProposal(r))
}
