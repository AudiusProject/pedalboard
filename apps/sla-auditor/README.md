# SLA Auditor

Checks discovery and content node versions against chain minimums (from `getExpectedServiceVersions`). Every 10 minutes:

- Fetches discovery and content nodes from chain (via `@audius/sdk-legacy` AudiusLibs)
- Calls each node’s `/health_check` for version and service type
- Writes version data to `sla_auditor_version_data` in the discovery DB
- If a node has been non-compliant (below min major/minor) for 24h, submits a governance proposal to slash 3000 $AUDIO

## Run locally

From pedalboard repo root:

```bash
turbo run build --filter=@pedalboard/sla-auditor
node apps/sla-auditor/dist/index.js
```

Use `dryRun=true` to log proposals without submitting.

## Environment

- `audius_db_url` – discovery DB (used by basekit)
- `audius_delegate_owner_wallet` – delegate wallet public key
- `audius_delegate_private_key` – delegate private key (required)
- `audius_web3_eth_provider_url` – Ethereum RPC URL (required)
- `audius_eth_token_address` – token contract address
- `audius_eth_contracts_registry` – contracts registry address
- `dryRun` – set to `true` to skip submitting governance proposals

## Docker

Built as `audius/pedalboard:sla-auditor-<tag>`. From repo root:

```bash
./scripts/docker.sh sla-auditor --tag latest
```
