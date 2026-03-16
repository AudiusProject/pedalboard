import HDWalletProvider from '@truffle/hdwallet-provider'
import Web3 from 'web3'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AudiusLibs } = require('@audius/sdk-legacy/dist/libs')

const publicKey = process.env.audius_delegate_owner_wallet
const privateKey = process.env.audius_delegate_private_key
const providerEndpoint = process.env.audius_web3_eth_provider_url

export async function initAudiusLibs (): Promise<InstanceType<typeof AudiusLibs>> {
  if (!privateKey) {
    throw new Error('Missing privateKey')
  }
  if (!providerEndpoint) {
    throw new Error('Missing providerEndpoint')
  }
  const localKeyProvider = new HDWalletProvider({
    privateKeys: [privateKey],
    providerOrUrl: providerEndpoint
  })
  const providers = [new Web3(localKeyProvider as unknown as Web3['currentProvider'])]
  const audiusLibs = new AudiusLibs({
    ethWeb3Config: AudiusLibs.configEthWeb3(
      process.env.audius_eth_token_address,
      process.env.audius_eth_contracts_registry,
      providers,
      publicKey
    ),
    isServer: true,
    enableUserReplicaSetManagerContract: true
  })
  await audiusLibs.init()
  return audiusLibs
}
