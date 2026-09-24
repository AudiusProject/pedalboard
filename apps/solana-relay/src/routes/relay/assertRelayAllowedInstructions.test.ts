import assert from 'assert'

import {
  ClaimableTokensProgram,
  RewardManagerProgram,
  RewardManagerInstruction
} from '@audius/spl'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  AuthorityType,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createInitializeAccountInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction
} from '@solana/spl-token'
import {
  Keypair,
  PublicKey,
  Secp256k1Program,
  SystemProgram,
  TransactionInstruction
} from '@solana/web3.js'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

import { config } from '../../config'
import { rateLimitClaimableTokenAccountRecreation } from '../../redis'

import { InvalidRelayInstructionError } from './InvalidRelayInstructionError'
import {
  assertRelayAllowedInstructions,
  computeInstructionDiscriminant,
  JUPITER_ROUTE_DISCRIMINANT,
  JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINANT
} from './assertRelayAllowedInstructions'
import { wasClaimableTokenAccountPreviouslyCreated } from './claimableTokenAccountHistory'

vi.mock('../../redis', () => ({
  rateLimitClaimableTokenAccountRecreation: vi.fn(),
  rateLimitTokenAccountCreation: vi.fn(async () => {
    throw new Error('Token account creation rate limit exceeded')
  })
}))

vi.mock('./claimableTokenAccountHistory', () => ({
  wasClaimableTokenAccountPreviouslyCreated: vi.fn()
}))

vi.mock('../../utils/connections', () => ({
  getConnection: () => ({
    getMinimumBalanceForRentExemption: async () => 2_039_280
  })
}))

const CLAIMABLE_TOKEN_PROGRAM_ID = new PublicKey(config.claimableTokenProgramId)

const REWARD_MANAGER_PROGRAM_ID = new PublicKey(config.rewardsManagerProgramId)
const REWARD_MANAGER_ACCOUNT = new PublicKey(
  config.rewardsManagerAccountAddress
)

const MEMO_PROGRAM_ID = new PublicKey(
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'
)
const MEMO_V2_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
)

const usdcMintKey = new PublicKey(config.usdcMintAddress)
const audioMintKey = new PublicKey(config.waudioMintAddress)

const usdcClaimableTokenAuthority = ClaimableTokensProgram.deriveAuthority({
  programId: CLAIMABLE_TOKEN_PROGRAM_ID,
  mint: usdcMintKey
})
const audioClaimableTokenAuthority = ClaimableTokensProgram.deriveAuthority({
  programId: CLAIMABLE_TOKEN_PROGRAM_ID,
  mint: audioMintKey
})

const getRandomPublicKey = () => Keypair.generate().publicKey

describe('Solana Relay', function () {
  describe('Jupiter Instruction Discriminant Computation', function () {
    it('should compute correct discriminant for route instruction', function () {
      const discriminant = computeInstructionDiscriminant('route')
      expect(discriminant.length).toBe(8)
      expect(discriminant).toEqual(JUPITER_ROUTE_DISCRIMINANT)
    })

    it('should compute correct discriminant for shared_accounts_route instruction', function () {
      const discriminant = computeInstructionDiscriminant(
        'shared_accounts_route'
      )
      expect(discriminant.length).toBe(8)
      expect(discriminant).toEqual(JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINANT)
    })

    it('should produce different discriminants for different instruction names', function () {
      const routeDiscriminant = computeInstructionDiscriminant('route')
      const sharedRouteDiscriminant = computeInstructionDiscriminant(
        'shared_accounts_route'
      )
      const customDiscriminant =
        computeInstructionDiscriminant('custom_instruction')

      expect(routeDiscriminant).not.toEqual(sharedRouteDiscriminant)
      expect(routeDiscriminant).not.toEqual(customDiscriminant)
      expect(sharedRouteDiscriminant).not.toEqual(customDiscriminant)
    })

    it('should be deterministic - same input produces same output', function () {
      const discriminant1 = computeInstructionDiscriminant('test_instruction')
      const discriminant2 = computeInstructionDiscriminant('test_instruction')
      expect(discriminant1).toEqual(discriminant2)
    })
  })

  describe('Jupiter Instruction Error Handling', function () {
    it('should handle malformed Jupiter instructions gracefully', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )

      // Create instruction with valid discriminant but insufficient accounts
      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: JUPITER_ROUTE_DISCRIMINANT,
          keys: [] // No accounts provided
        })
      ]

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: {
              wallet: 'something',
              is_verified: false
            }
          }),
        InvalidRelayInstructionError
      )
    })

    it('should handle Jupiter instructions with corrupted account data', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )

      // Create sharedAccountsRoute instruction with insufficient keys
      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINANT,
          keys: [
            {
              pubkey: TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false
            }
            // Missing required accounts
          ]
        })
      ]

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: {
              wallet: 'something',
              is_verified: false
            }
          }),
        InvalidRelayInstructionError,
        'Failed to parse Jupiter'
      )
    })
  })
  beforeEach(() => {
    vi.mocked(wasClaimableTokenAccountPreviouslyCreated).mockReset()
    vi.mocked(wasClaimableTokenAccountPreviouslyCreated).mockResolvedValue(
      false
    )
    vi.mocked(rateLimitClaimableTokenAccountRecreation).mockReset()
    vi.mocked(rateLimitClaimableTokenAccountRecreation).mockResolvedValue(
      undefined
    )

    // Mock initializeDiscoveryDb to avoid real DB connection
    vi.mock('@pedalboard/basekit', () => ({
      initializeDiscoveryDb: vi.fn(() => ({
        select: vi.fn(() => ({
          from: vi.fn(() => []) // returns empty array for artist_coins
        }))
      }))
    }))
    // Mock getAllowedMints to always return audioMintKey and usdcMintKey
    vi.mock('./getAllowedMints', () => ({
      getAllowedMints: vi.fn(async () => [
        config.usdcMintAddress,
        config.waudioMintAddress
      ])
    }))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Associated Token Account Program', function () {
    it('should allow create token account with matching close for valid mints', async function () {
      const payer = getRandomPublicKey()
      const associatedToken = getRandomPublicKey()
      const owner = getRandomPublicKey()

      // Basic case
      const instructions = [
        createAssociatedTokenAccountInstruction(
          payer,
          associatedToken,
          owner,
          usdcMintKey
        ),
        createCloseAccountInstruction(associatedToken, payer, owner)
      ]
      await assertRelayAllowedInstructions(instructions)
    })

    it('should allow create/close matches regardless of order', async function () {
      const payer = getRandomPublicKey()
      const associatedToken = getRandomPublicKey()
      const owner = getRandomPublicKey()
      const associatedToken2 = getRandomPublicKey()
      const payer2 = getRandomPublicKey()
      const complexInstructions = [
        createCloseAccountInstruction(associatedToken2, payer2, owner),
        createAssociatedTokenAccountInstruction(
          payer2,
          associatedToken2,
          owner,
          usdcMintKey
        ),
        createAssociatedTokenAccountInstruction(
          payer,
          associatedToken,
          owner,
          NATIVE_MINT
        ),
        createCloseAccountInstruction(associatedToken, payer, owner)
      ]
      await assertRelayAllowedInstructions(complexInstructions)
    })

    it('should not allow create token account without close', async function () {
      const payer = getRandomPublicKey()
      const associatedToken = getRandomPublicKey()
      const owner = getRandomPublicKey()

      // Ensure every associated token account create instruction has a close account instruction
      const missingCloseInstructions = [
        createAssociatedTokenAccountInstruction(
          payer,
          associatedToken,
          owner,
          usdcMintKey
        )
      ]
      await assert.rejects(
        async () => assertRelayAllowedInstructions(missingCloseInstructions),
        InvalidRelayInstructionError,
        'Missing close instructions'
      )

      // Ensure the payer is refunded
      const unmatchedPayerInstructions = [
        createAssociatedTokenAccountInstruction(
          payer,
          associatedToken,
          owner,
          usdcMintKey
        ),
        createCloseAccountInstruction(
          associatedToken,
          getRandomPublicKey(),
          owner
        )
      ]
      await assert.rejects(
        async () => assertRelayAllowedInstructions(unmatchedPayerInstructions),
        InvalidRelayInstructionError,
        'Mismatched account creation payer and close instruction destination'
      )

      // Ensure both instructions are for the same account
      const unmatchedAccountInstructions = [
        createAssociatedTokenAccountInstruction(
          payer,
          associatedToken,
          owner,
          usdcMintKey
        ),
        createCloseAccountInstruction(getRandomPublicKey(), payer, owner)
      ]
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(unmatchedAccountInstructions),
        InvalidRelayInstructionError,
        'Mismatched target token accounts'
      )
    })

    it('should not allow create token account with arbitrary mints', async function () {
      const payer = getRandomPublicKey()
      const associatedToken = getRandomPublicKey()
      const owner = getRandomPublicKey()
      const mint = getRandomPublicKey()
      const instructions = [
        createAssociatedTokenAccountInstruction(
          payer,
          associatedToken,
          owner,
          mint
        ),
        createCloseAccountInstruction(associatedToken, payer, owner)
      ]
      await assert.rejects(
        async () => assertRelayAllowedInstructions(instructions),
        InvalidRelayInstructionError,
        'Mint not allowed'
      )
    })

    it('should allow exactly one fee-payer-funded create without matching close when fee payer receives rent exemption via System Transfer', async function () {
      const wallet = '0xe42b199d864489387bf64262874fc6472bcbc151'
      const feePayer = config.solanaFeePayerWallets[0].publicKey
      const fromPubkey = getRandomPublicKey()
      const recipientAta = getRandomPublicKey()
      const recipientOwner = getRandomPublicKey()
      const rentExemptionLamports = 2_039_280
      const instructions = [
        SystemProgram.transfer({
          fromPubkey,
          toPubkey: feePayer,
          lamports: rentExemptionLamports
        }),
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer,
          recipientAta,
          recipientOwner,
          usdcMintKey
        )
      ]
      await assertRelayAllowedInstructions(instructions, {
        user: { wallet, is_verified: false },
        feePayer: feePayer.toBase58()
      })
    })

    it('should not allow fee-payer-funded create when fee payer receives less than rent exemption via System Transfer', async function () {
      const wallet = '0xe42b199d864489387bf64262874fc6472bcbc151'
      const feePayer = config.solanaFeePayerWallets[0].publicKey
      const fromPubkey = getRandomPublicKey()
      const recipientAta = getRandomPublicKey()
      const recipientOwner = getRandomPublicKey()
      const belowRentExemptionLamports = 2_039_279
      const instructions = [
        SystemProgram.transfer({
          fromPubkey,
          toPubkey: feePayer,
          lamports: belowRentExemptionLamports
        }),
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer,
          recipientAta,
          recipientOwner,
          usdcMintKey
        )
      ]
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: { wallet, is_verified: false },
            feePayer: feePayer.toBase58()
          }),
        InvalidRelayInstructionError,
        'Mismatched number of create and close instructions'
      )
    })

    it('should not allow fee-payer-funded create without matching close when there is no reimbursement', async function () {
      const feePayer = config.solanaFeePayerWallets[0].publicKey
      const recipientAta = getRandomPublicKey()
      const recipientOwner = getRandomPublicKey()
      const instructions = [
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer,
          recipientAta,
          recipientOwner,
          usdcMintKey
        )
      ]
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            feePayer: feePayer.toBase58()
          }),
        InvalidRelayInstructionError,
        'Mismatched number of create and close instructions'
      )
    })
  })

  describe('Token Program', function () {
    it('should allow close instructions', async function () {
      const payer = getRandomPublicKey()
      const associatedToken = getRandomPublicKey()
      const owner = getRandomPublicKey()
      const instructions = [
        createCloseAccountInstruction(associatedToken, payer, owner)
      ]
      await assertRelayAllowedInstructions(instructions)
    })

    it('should allow USDC transfers to userbanks', async function () {
      // Dummy eth address to make the encoder happy
      const wallet = '0xe42b199d864489387bf64262874fc6472bcbc151'
      const userbank = await ClaimableTokensProgram.deriveUserBank({
        claimableTokensPDA: usdcClaimableTokenAuthority,
        ethAddress: wallet
      })

      const source = getRandomPublicKey()
      const owner = getRandomPublicKey()
      const instructions = [
        createTransferCheckedInstruction(
          source,
          usdcMintKey,
          userbank,
          owner,
          1,
          6
        )
      ]
      await assertRelayAllowedInstructions(instructions, {
        user: {
          wallet,
          is_verified: false
        }
      })
    })

    it('should not allow transfers to non-userbanks', async function () {
      // Some dummy eth addresses to make the encoder happy
      const wallet = '0x1dc3070311552fce47e06db9f4f1328187f14c85'

      const source = getRandomPublicKey()
      const owner = getRandomPublicKey()
      const destination = getRandomPublicKey()
      const instructions = [
        createTransferCheckedInstruction(
          source,
          usdcMintKey,
          destination,
          owner,
          1,
          6
        )
      ]

      await assert.rejects(
        async () => assertRelayAllowedInstructions(instructions),
        InvalidRelayInstructionError,
        'Not logged in'
      )

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: {
              wallet,
              is_verified: false
            }
          }),
        InvalidRelayInstructionError,
        'Transfer not to userbank'
      )
    })

    it('should allow syncNative instructions', async function () {
      await assertRelayAllowedInstructions([
        createSyncNativeInstruction(getRandomPublicKey())
      ])
    })

    it('should not allow other instructions (non-exhaustive)', async function () {
      const account = getRandomPublicKey()
      const owner = getRandomPublicKey()
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            createInitializeAccountInstruction(account, usdcMintKey, owner)
          ]),
        InvalidRelayInstructionError,
        'initializeAccount'
      )
      const delegate = getRandomPublicKey()
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            createApproveInstruction(account, delegate, owner, 0)
          ]),
        InvalidRelayInstructionError,
        'approve'
      )
    })
  })

  describe('Reward Manager Program', function () {
    it('should allow public instructions with valid reward manager', async function () {
      const disbursementId = 'some:id:thing'
      // Some dummy eth addresses to make the encoder happy
      const senderEthAddress = '0x1dc3070311552fce47e06db9f4f1328187f14c85'
      const operatorEthAddress = '0x430ef095e4c5ac71a465b30d566bab0bb0985346'
      const recipientEthAddress = '0x7311c8ec02f087cba0fdbb056d4cebc86519d871'
      const attestations = getRandomPublicKey()
      const authority = getRandomPublicKey()
      const payer = getRandomPublicKey()
      const sender = getRandomPublicKey()
      const rewardManagerTokenSource = getRandomPublicKey()
      const destinationUserBank = getRandomPublicKey()
      const disbursementAccount = getRandomPublicKey()
      const antiAbuseOracle = getRandomPublicKey()
      const existingSenders = [
        getRandomPublicKey(),
        getRandomPublicKey(),
        getRandomPublicKey()
      ]
      await assertRelayAllowedInstructions([
        RewardManagerProgram.createSenderPublicInstruction({
          senderEthAddress,
          operatorEthAddress,
          rewardManagerState: REWARD_MANAGER_ACCOUNT,
          authority,
          payer,
          sender,
          existingSenders,
          rewardManagerProgramId: REWARD_MANAGER_PROGRAM_ID
        }),
        RewardManagerProgram.createSubmitAttestationInstruction({
          disbursementId,
          attestations,
          rewardManagerState: REWARD_MANAGER_ACCOUNT,
          authority,
          payer,
          sender,
          rewardManagerProgramId: REWARD_MANAGER_PROGRAM_ID
        }),
        RewardManagerProgram.createEvaluateAttestationsInstruction({
          disbursementId,
          recipientEthAddress,
          amount: BigInt(100),
          attestations,
          rewardManagerState: REWARD_MANAGER_ACCOUNT,
          authority,
          rewardManagerTokenSource,
          destinationUserBank,
          disbursementAccount,
          antiAbuseOracle,
          payer,
          tokenProgramId: TOKEN_PROGRAM_ID,
          rewardManagerProgramId: REWARD_MANAGER_PROGRAM_ID
        })
      ])
    })

    it('should not allow public instructions with invalid reward manager', async function () {
      const disbursementId = 'some:id:thing'
      // Some dummy eth addresses to make the encoder happy
      const senderEthAddress = '0x1dc3070311552fce47e06db9f4f1328187f14c85'
      const operatorEthAddress = '0x430ef095e4c5ac71a465b30d566bab0bb0985346'
      const recipientEthAddress = '0x7311c8ec02f087cba0fdbb056d4cebc86519d871'
      const attestations = getRandomPublicKey()
      const authority = getRandomPublicKey()
      const payer = getRandomPublicKey()
      const sender = getRandomPublicKey()
      const rewardManagerState = getRandomPublicKey()
      const rewardManagerTokenSource = getRandomPublicKey()
      const destinationUserBank = getRandomPublicKey()
      const disbursementAccount = getRandomPublicKey()
      const antiAbuseOracle = getRandomPublicKey()
      const existingSenders = [
        getRandomPublicKey(),
        getRandomPublicKey(),
        getRandomPublicKey()
      ]
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            RewardManagerProgram.createSenderPublicInstruction({
              senderEthAddress,
              operatorEthAddress,
              rewardManagerState,
              authority,
              payer,
              sender,
              existingSenders,
              rewardManagerProgramId: REWARD_MANAGER_PROGRAM_ID
            })
          ]),
        InvalidRelayInstructionError,
        'invalid reward manager for createSenderPublic'
      )

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            RewardManagerProgram.createSubmitAttestationInstruction({
              disbursementId,
              attestations,
              rewardManagerState,
              authority,
              payer,
              sender,
              rewardManagerProgramId: REWARD_MANAGER_PROGRAM_ID
            })
          ]),
        InvalidRelayInstructionError,
        'invalid reward manager for submitAttestation'
      )
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            RewardManagerProgram.createEvaluateAttestationsInstruction({
              disbursementId,
              recipientEthAddress,
              amount: BigInt(100),
              attestations,
              rewardManagerState,
              authority,
              rewardManagerTokenSource,
              destinationUserBank,
              disbursementAccount,
              antiAbuseOracle,
              payer,
              tokenProgramId: TOKEN_PROGRAM_ID,
              rewardManagerProgramId: REWARD_MANAGER_PROGRAM_ID
            })
          ]),
        InvalidRelayInstructionError,
        'invalid reward manager for evaluateAttestations'
      )
    })

    it('should not allow non-public instructions', async function () {
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            new TransactionInstruction({
              programId: REWARD_MANAGER_PROGRAM_ID,
              keys: [],
              data: Buffer.from([RewardManagerInstruction.Init])
            })
          ]),
        'reward manager init'
      )
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            new TransactionInstruction({
              programId: REWARD_MANAGER_PROGRAM_ID,
              keys: [],
              data: Buffer.from([RewardManagerInstruction.ChangeManagerAccount])
            })
          ]),
        'reward manager change manager account'
      )
      // Some dummy eth addresses to make the encoder happy
      const senderEthAddress = '0x1dc3070311552fce47e06db9f4f1328187f14c85'
      const operatorEthAddress = '0x430ef095e4c5ac71a465b30d566bab0bb0985346'
      const authority = getRandomPublicKey()
      const payer = getRandomPublicKey()
      const sender = getRandomPublicKey()
      const rewardManagerState = getRandomPublicKey()
      const manager = getRandomPublicKey()
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            RewardManagerProgram.createSenderInstruction({
              senderEthAddress,
              operatorEthAddress,
              rewardManagerState,
              manager,
              authority,
              payer,
              sender,
              rewardManagerProgramId: REWARD_MANAGER_PROGRAM_ID
            })
          ]),
        'reward manager create sender'
      )
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            new TransactionInstruction({
              programId: REWARD_MANAGER_PROGRAM_ID,
              keys: [],
              data: Buffer.from([RewardManagerInstruction.DeleteSender])
            })
          ]),
        'non public delete sender'
      )
    })
  })

  describe('Claimable Tokens Program', function () {
    const ethPrivateKey = secp256k1.utils.randomPrivateKey()
    const blockhash = getRandomPublicKey().toBase58()

    // @audius/spl uses its own @solana/spl-token, whose AuthorityType enum
    // has the same values but is a distinct type
    type SplAuthorityType = Parameters<
      typeof ClaimableTokensProgram.createSignedSetAuthorityData
    >[0]['authorityType']

    const toEthAddress = (privateKey: Uint8Array) =>
      '0x' +
      Buffer.from(
        Secp256k1Program.publicKeyToEthAddress(
          secp256k1.getPublicKey(privateKey, false).slice(1)
        )
      ).toString('hex')

    /**
     * Creates a user bank creation with the Secp256k1 and SetAuthority
     * instructions that set its close authority, overridable to build
     * invalid variants.
     */
    const createUserBankInstructions = async ({
      authority = audioClaimableTokenAuthority,
      privateKey = ethPrivateKey,
      signerPrivateKey = privateKey,
      instructionIndex = 0,
      authorityType = AuthorityType.CloseAccount,
      newAuthority = ClaimableTokensProgram.rentDestination,
      signedUserBank
    }: {
      authority?: PublicKey
      privateKey?: Uint8Array
      signerPrivateKey?: Uint8Array
      instructionIndex?: number
      authorityType?: AuthorityType
      newAuthority?: PublicKey
      signedUserBank?: PublicKey
    } = {}) => {
      const ethAddress = toEthAddress(privateKey)
      const userBank = await ClaimableTokensProgram.deriveUserBank({
        ethAddress,
        claimableTokensPDA: authority
      })
      const message = ClaimableTokensProgram.createSignedSetAuthorityData({
        blockhash,
        userBank: signedUserBank ?? userBank,
        authorityType: authorityType as number as SplAuthorityType,
        newAuthority
      })
      const create = ClaimableTokensProgram.createAccountInstruction({
        ethAddress,
        payer: getRandomPublicKey(),
        mint: getRandomPublicKey(),
        authority,
        userBank,
        programId: CLAIMABLE_TOKEN_PROGRAM_ID
      })
      const secp = Secp256k1Program.createInstructionWithPrivateKey({
        privateKey: signerPrivateKey,
        message,
        instructionIndex: instructionIndex + 1
      })
      const setAuthority = ClaimableTokensProgram.createSetAuthorityInstruction({
        userBank,
        authority,
        programId: CLAIMABLE_TOKEN_PROGRAM_ID
      })
      return {
        ethAddress,
        userBank,
        create,
        secp,
        setAuthority,
        instructions: [create, secp, setAuthority]
      }
    }

    it('should allow creation that sets the close authority to the rent destination', async function () {
      const { instructions } = await createUserBankInstructions()
      await assertRelayAllowedInstructions(instructions)
    })

    it('should reject creation without setting the close authority', async function () {
      const { create } = await createUserBankInstructions()
      await expect(assertRelayAllowedInstructions([create])).rejects.toThrow(
        'must set the close authority'
      )
    })

    it('should reject creation that sets the close authority to another account', async function () {
      const { instructions } = await createUserBankInstructions({
        newAuthority: getRandomPublicKey()
      })
      await expect(assertRelayAllowedInstructions(instructions)).rejects.toThrow(
        InvalidRelayInstructionError
      )
    })

    it('should reject creation that transfers ownership instead', async function () {
      const { instructions } = await createUserBankInstructions({
        authorityType: AuthorityType.AccountOwner,
        newAuthority: getRandomPublicKey()
      })
      await expect(assertRelayAllowedInstructions(instructions)).rejects.toThrow(
        InvalidRelayInstructionError
      )
    })

    it('should reject a close authority signed by a different wallet', async function () {
      const { instructions } = await createUserBankInstructions({
        signerPrivateKey: secp256k1.utils.randomPrivateKey()
      })
      await expect(assertRelayAllowedInstructions(instructions)).rejects.toThrow(
        InvalidRelayInstructionError
      )
    })

    it('should reject a close authority signed for a different user bank', async function () {
      const { instructions } = await createUserBankInstructions({
        signedUserBank: getRandomPublicKey()
      })
      await expect(assertRelayAllowedInstructions(instructions)).rejects.toThrow(
        InvalidRelayInstructionError
      )
    })

    it('should reject a close authority for a different user bank than the one created', async function () {
      const first = await createUserBankInstructions()
      const second = await createUserBankInstructions({
        privateKey: secp256k1.utils.randomPrivateKey(),
        instructionIndex: 1
      })
      // Creates the first user bank, but sets the close authority of the second
      await expect(
        assertRelayAllowedInstructions([
          first.create,
          second.secp,
          second.setAuthority
        ])
      ).rejects.toThrow('must set the close authority')
    })

    it('should reject a Secp256k1 instruction with the wrong instruction index', async function () {
      const { instructions } = await createUserBankInstructions({
        instructionIndex: 1
      })
      await expect(assertRelayAllowedInstructions(instructions)).rejects.toThrow(
        InvalidRelayInstructionError
      )
    })

    it('should reject SetAuthority without a preceding Secp256k1 instruction', async function () {
      const { create, setAuthority } = await createUserBankInstructions()
      await expect(
        assertRelayAllowedInstructions([create, setAuthority])
      ).rejects.toThrow(InvalidRelayInstructionError)
    })

    it('should reject the mainnet ownership transfer SetAuthority', async function () {
      // Transaction: 5P5QZjQhzhik7b4YGVmkBpiTRXzKKMqApL86bEjYXMjq8LJkvQkRJzbCyy5yTw7oJjqgcUQoExawXLMUpANuNyts
      const userBank = new PublicKey(
        'Bwde2Eu9FQMuV9RTwNj2vng8u92aRV1rjXzMyQJu83Ph'
      )
      await expect(
        assertRelayAllowedInstructions([
          new TransactionInstruction({
            programId: Secp256k1Program.programId,
            keys: [],
            data: Buffer.from(
              'ASAAAAwAAGEAZwAAqa3Sldm1AP3Y5pW+XrSKsPWTSCY10DPjmy9H41ybWn1qnOD228tHJKP+2HVAoPYR/cp2NzDisog8Dhz+WpNrj1uvhx0FxK6CFpFnb9JZDCvQvdznAZ5oFp2hVwxgLEHrv0cngiL0NOpUdI/Qgk9bYH/htvWJIwAAAAYCAWNLDNbw11p9JYiGsQAm7ZmCOYs7zB0BRLQWG/CxkJOkopOo9nn6aEg4D4369kn7ivc9gOWiruJ81acljr1S/yQ=',
              'base64'
            )
          }),
          ClaimableTokensProgram.createSetAuthorityInstruction({
            userBank,
            authority: audioClaimableTokenAuthority,
            programId: CLAIMABLE_TOKEN_PROGRAM_ID
          })
        ])
      ).rejects.toThrow(InvalidRelayInstructionError)
    })

    it('should reject Close instructions', async function () {
      const { ethAddress, userBank } = await createUserBankInstructions()
      await expect(
        assertRelayAllowedInstructions([
          new TransactionInstruction({
            programId: CLAIMABLE_TOKEN_PROGRAM_ID,
            keys: [
              { pubkey: userBank, isSigner: false, isWritable: true },
              {
                pubkey: audioClaimableTokenAuthority,
                isSigner: false,
                isWritable: false
              },
              {
                pubkey: ClaimableTokensProgram.rentDestination,
                isSigner: false,
                isWritable: true
              },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
            ],
            data: Buffer.concat([
              Buffer.from([3]),
              Buffer.from(ethAddress.slice(2), 'hex')
            ])
          })
        ])
      ).rejects.toThrow('Unsupported Claimable Tokens Program instruction')
    })

    it('should not consume the recreation limit for first-time account creation', async function () {
      const { userBank, instructions } = await createUserBankInstructions()

      await assertRelayAllowedInstructions(instructions)

      expect(wasClaimableTokenAccountPreviouslyCreated).toHaveBeenCalledWith(
        userBank.toBase58()
      )
      expect(rateLimitClaimableTokenAccountRecreation).not.toHaveBeenCalled()
    })

    it('should consume the recreation limit for previously created accounts', async function () {
      vi.mocked(wasClaimableTokenAccountPreviouslyCreated).mockResolvedValue(
        true
      )
      const { userBank, instructions } = await createUserBankInstructions()

      await assertRelayAllowedInstructions(instructions)

      expect(rateLimitClaimableTokenAccountRecreation).toHaveBeenCalledWith(
        userBank.toBase58()
      )
    })

    it('should reject a recreation when the system limit is exhausted', async function () {
      vi.mocked(wasClaimableTokenAccountPreviouslyCreated).mockResolvedValue(
        true
      )
      vi.mocked(rateLimitClaimableTokenAccountRecreation).mockRejectedValue(
        new Error(
          'System has recreated too many claimable token accounts today'
        )
      )
      const { instructions } = await createUserBankInstructions()

      await expect(assertRelayAllowedInstructions(instructions)).rejects.toThrow(
        'System has recreated too many claimable token accounts today'
      )
    })

    it('should allow claimable token program instructions with valid authority', async function () {
      const payer = getRandomPublicKey()
      const destination = getRandomPublicKey()
      const nonceAccount = getRandomPublicKey()
      const usdc = await createUserBankInstructions({
        authority: usdcClaimableTokenAuthority
      })
      const audio = await createUserBankInstructions({
        authority: audioClaimableTokenAuthority,
        instructionIndex: 4
      })
      const instructions = [
        ...usdc.instructions,
        ClaimableTokensProgram.createTransferInstruction({
          payer,
          sourceEthAddress: usdc.ethAddress,
          sourceUserBank: usdc.userBank,
          destination,
          nonceAccount,
          authority: usdcClaimableTokenAuthority,
          programId: CLAIMABLE_TOKEN_PROGRAM_ID
        }),
        ...audio.instructions,
        ClaimableTokensProgram.createTransferInstruction({
          payer,
          sourceEthAddress: audio.ethAddress,
          sourceUserBank: audio.userBank,
          destination,
          nonceAccount,
          authority: audioClaimableTokenAuthority,
          programId: CLAIMABLE_TOKEN_PROGRAM_ID
        })
      ]
      await assertRelayAllowedInstructions(instructions)
    })

    it('should not allow claimable token program instructions with invalid authority', async function () {
      // Dummy eth addresse to make the encoder happy
      const wallet = '0x36034724e7bda41d5142efd85e1f6773460f5679'
      const payer = getRandomPublicKey()
      const mint = getRandomPublicKey()
      const authority = getRandomPublicKey()
      const userBank = getRandomPublicKey()
      const destination = getRandomPublicKey()
      const nonceAccount = getRandomPublicKey()
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            ClaimableTokensProgram.createAccountInstruction({
              ethAddress: wallet,
              payer,
              mint,
              authority,
              userBank
            })
          ]),
        'Invalid authority for create user bank'
      )
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            ClaimableTokensProgram.createTransferInstruction({
              payer,
              sourceEthAddress: wallet,
              sourceUserBank: userBank,
              destination,
              nonceAccount,
              authority
            })
          ]),
        InvalidRelayInstructionError,
        'Invalid authority for transfer user bank'
      )
    })
  })

  describe('Jupiter Swap Program', function () {
    it('should allow Jupiter sharedAccountsRoute swaps between USDC and SOL when authenticated', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )
      const programAuthority = getRandomPublicKey()
      const userTransferAuthority = getRandomPublicKey()
      const sourceTokenAccount = getRandomPublicKey()
      const programSourceTokenAccount = getRandomPublicKey()
      const programDestinationTokenAccount = getRandomPublicKey()
      const destinationTokenAccount = getRandomPublicKey()
      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: Buffer.from([
            193, 32, 155, 51, 65, 214, 156, 129, 2, 1, 0, 0, 0, 3, 100, 0, 1,
            92, 161, 0, 0, 0, 0, 0, 0, 236, 52, 31, 0, 0, 0, 0, 0, 3, 0, 0
          ]),
          keys: [
            {
              pubkey: TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: programAuthority,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: userTransferAuthority,
              isSigner: true,
              isWritable: true
            },
            {
              pubkey: sourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: programSourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: programDestinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: destinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: usdcMintKey,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: NATIVE_MINT,
              isSigner: false,
              isWritable: false
            }
          ]
        })
      ]

      await assertRelayAllowedInstructions(instructions, {
        user: {
          wallet: 'something',
          is_verified: false
        }
      })
    })

    it('should not allow Jupiter sharedAccountsRoute when not authenticated', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )
      const programAuthority = getRandomPublicKey()
      const userTransferAuthority = getRandomPublicKey()
      const sourceTokenAccount = getRandomPublicKey()
      const programSourceTokenAccount = getRandomPublicKey()
      const programDestinationTokenAccount = getRandomPublicKey()
      const destinationTokenAccount = getRandomPublicKey()
      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: Buffer.from([
            193, 32, 155, 51, 65, 214, 156, 129, 2, 1, 0, 0, 0, 3, 100, 0, 1,
            92, 161, 0, 0, 0, 0, 0, 0, 236, 52, 31, 0, 0, 0, 0, 0, 3, 0, 0
          ]),
          keys: [
            {
              pubkey: TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: programAuthority,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: userTransferAuthority,
              isSigner: true,
              isWritable: true
            },
            {
              pubkey: sourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: programSourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: programDestinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: destinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: usdcMintKey,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: NATIVE_MINT,
              isSigner: false,
              isWritable: false
            }
          ]
        })
      ]

      await assert.rejects(
        async () => assertRelayAllowedInstructions(instructions),
        InvalidRelayInstructionError,
        'Unauthorized'
      )
    })

    it('should not allow Jupiter sharedAccountsRoute swaps between other mints', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )
      const programAuthority = getRandomPublicKey()
      const userTransferAuthority = getRandomPublicKey()
      const sourceTokenAccount = getRandomPublicKey()
      const programSourceTokenAccount = getRandomPublicKey()
      const programDestinationTokenAccount = getRandomPublicKey()
      const destinationTokenAccount = getRandomPublicKey()
      const randomDestinationMint = getRandomPublicKey()
      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: Buffer.from([
            193, 32, 155, 51, 65, 214, 156, 129, 2, 1, 0, 0, 0, 3, 100, 0, 1,
            92, 161, 0, 0, 0, 0, 0, 0, 236, 52, 31, 0, 0, 0, 0, 0, 3, 0, 0
          ]),
          keys: [
            {
              pubkey: TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: programAuthority,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: userTransferAuthority,
              isSigner: true,
              isWritable: true
            },
            {
              pubkey: sourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: programSourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: programDestinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: destinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: usdcMintKey,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: randomDestinationMint,
              isSigner: false,
              isWritable: false
            }
          ]
        })
      ]

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: {
              wallet: 'something',
              is_verified: false
            }
          }),
        InvalidRelayInstructionError,
        'Invalid mints for swap'
      )
    })

    it('should not allow Jupiter sharedAccountsRoute swaps using the fee payer', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )
      const programAuthority = getRandomPublicKey()
      const userTransferAuthority = config.solanaFeePayerWallets[0].publicKey
      const sourceTokenAccount = getRandomPublicKey()
      const programSourceTokenAccount = getRandomPublicKey()
      const programDestinationTokenAccount = getRandomPublicKey()
      const destinationTokenAccount = getRandomPublicKey()
      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: Buffer.from([
            193, 32, 155, 51, 65, 214, 156, 129, 2, 1, 0, 0, 0, 3, 100, 0, 1,
            92, 161, 0, 0, 0, 0, 0, 0, 236, 52, 31, 0, 0, 0, 0, 0, 3, 0, 0
          ]),
          keys: [
            {
              pubkey: TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: programAuthority,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: userTransferAuthority,
              isSigner: true,
              isWritable: true
            },
            {
              pubkey: sourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: programSourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: programDestinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: destinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: usdcMintKey,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: NATIVE_MINT,
              isSigner: false,
              isWritable: false
            }
          ]
        })
      ]

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: {
              wallet: 'something',
              is_verified: false
            }
          }),
        InvalidRelayInstructionError,
        'Invalid user transfer authority'
      )
    })

    it('should allow Jupiter route instruction swaps when authenticated', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )
      const userTransferAuthority = getRandomPublicKey()
      const userSourceTokenAccount = getRandomPublicKey()
      const userDestinationTokenAccount = getRandomPublicKey()
      const destinationTokenAccount = getRandomPublicKey()
      const platformFeeAccount = getRandomPublicKey()
      const eventAuthority = getRandomPublicKey()
      const program = getRandomPublicKey()

      // Create route instruction with proper discriminant
      const routeInstructionData = Buffer.concat([
        JUPITER_ROUTE_DISCRIMINANT,
        Buffer.alloc(32) // Additional instruction data
      ])

      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: routeInstructionData,
          keys: [
            {
              pubkey: TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: userTransferAuthority,
              isSigner: true,
              isWritable: true
            },
            {
              pubkey: userSourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: userDestinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: destinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: NATIVE_MINT, // destination mint
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: platformFeeAccount,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: eventAuthority,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: program,
              isSigner: false,
              isWritable: false
            }
          ]
        })
      ]

      await assertRelayAllowedInstructions(instructions, {
        user: {
          wallet: 'something',
          is_verified: false
        }
      })
    })

    it('should not allow Jupiter route instruction swaps to invalid destination mints', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )
      const userTransferAuthority = getRandomPublicKey()
      const userSourceTokenAccount = getRandomPublicKey()
      const userDestinationTokenAccount = getRandomPublicKey()
      const destinationTokenAccount = getRandomPublicKey()
      const platformFeeAccount = getRandomPublicKey()
      const eventAuthority = getRandomPublicKey()
      const program = getRandomPublicKey()
      const invalidDestinationMint = getRandomPublicKey()

      // Create route instruction with proper discriminant
      const routeInstructionData = Buffer.concat([
        JUPITER_ROUTE_DISCRIMINANT,
        Buffer.alloc(32) // Additional instruction data
      ])

      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: routeInstructionData,
          keys: [
            {
              pubkey: TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: userTransferAuthority,
              isSigner: true,
              isWritable: true
            },
            {
              pubkey: userSourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: userDestinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: destinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: invalidDestinationMint, // invalid destination mint
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: platformFeeAccount,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: eventAuthority,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: program,
              isSigner: false,
              isWritable: false
            }
          ]
        })
      ]

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: {
              wallet: 'something',
              is_verified: false
            }
          }),
        InvalidRelayInstructionError,
        'Invalid destination mint'
      )
    })

    it('should not allow Jupiter route instruction when using fee payer as transfer authority', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )
      const userTransferAuthority = config.solanaFeePayerWallets[0].publicKey
      const userSourceTokenAccount = getRandomPublicKey()
      const userDestinationTokenAccount = getRandomPublicKey()
      const destinationTokenAccount = getRandomPublicKey()
      const platformFeeAccount = getRandomPublicKey()
      const eventAuthority = getRandomPublicKey()
      const program = getRandomPublicKey()

      // Create route instruction with proper discriminant
      const routeInstructionData = Buffer.concat([
        JUPITER_ROUTE_DISCRIMINANT,
        Buffer.alloc(32) // Additional instruction data
      ])

      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: routeInstructionData,
          keys: [
            {
              pubkey: TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: userTransferAuthority,
              isSigner: true,
              isWritable: true
            },
            {
              pubkey: userSourceTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: userDestinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: destinationTokenAccount,
              isSigner: false,
              isWritable: true
            },
            {
              pubkey: NATIVE_MINT, // destination mint
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: platformFeeAccount,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: eventAuthority,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: program,
              isSigner: false,
              isWritable: false
            }
          ]
        })
      ]

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: {
              wallet: 'something',
              is_verified: false
            }
          }),
        InvalidRelayInstructionError,
        'Invalid transfer authority'
      )
    })

    it('should not allow Jupiter instructions with unknown discriminants', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )
      const userTransferAuthority = getRandomPublicKey()
      const userSourceTokenAccount = getRandomPublicKey()

      // Create instruction with unknown discriminant
      const unknownInstructionData = Buffer.concat([
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), // Unknown discriminant
        Buffer.alloc(32) // Additional instruction data
      ])

      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: unknownInstructionData,
          keys: [
            {
              pubkey: TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false
            },
            {
              pubkey: userTransferAuthority,
              isSigner: true,
              isWritable: true
            },
            {
              pubkey: userSourceTokenAccount,
              isSigner: false,
              isWritable: true
            }
          ]
        })
      ]

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: {
              wallet: 'something',
              is_verified: false
            }
          }),
        InvalidRelayInstructionError,
        'Unknown Instruction Type'
      )
    })

    it('should handle Jupiter instructions with insufficient data length', async function () {
      const JUPITER_AGGREGATOR_V6_PROGRAM_ID = new PublicKey(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      )
      const userTransferAuthority = getRandomPublicKey()

      // Create instruction with insufficient data (less than 8 bytes for discriminant)
      const shortInstructionData = Buffer.from([1, 2, 3]) // Only 3 bytes

      const instructions = [
        new TransactionInstruction({
          programId: JUPITER_AGGREGATOR_V6_PROGRAM_ID,
          data: shortInstructionData,
          keys: [
            {
              pubkey: userTransferAuthority,
              isSigner: true,
              isWritable: true
            }
          ]
        })
      ]

      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions(instructions, {
            user: {
              wallet: 'something',
              is_verified: false
            }
          }),
        InvalidRelayInstructionError,
        'Unknown Instruction Type'
      )
    })
  })

  describe('System Program', function () {
    it('should allow transfers when authenticated', async function () {
      const feePayer = getRandomPublicKey()
      const fromPubkey = getRandomPublicKey()
      const toPubkey = getRandomPublicKey()
      // Dummy eth address, no significance
      const wallet = '0x36034724e7bda41d5142efd85e1f6773460f5679'
      await assertRelayAllowedInstructions(
        [
          SystemProgram.transfer({
            fromPubkey,
            toPubkey,
            lamports: 1
          })
        ],
        { user: { wallet, is_verified: false }, feePayer: feePayer.toBase58() }
      )
    })

    it('should not allow transfers when not authenticated', async function () {
      const fromPubkey = getRandomPublicKey()
      const toPubkey = getRandomPublicKey()
      await assert.rejects(async () =>
        assertRelayAllowedInstructions([
          SystemProgram.transfer({
            fromPubkey,
            toPubkey,
            lamports: 1
          })
        ])
      )
    })

    it('should not allow transfers from the feePayer', async function () {
      const wallet = '0x36034724e7bda41d5142efd85e1f6773460f5679'
      const feePayer = getRandomPublicKey()
      const toPubkey = getRandomPublicKey()
      await assert.rejects(async () =>
        assertRelayAllowedInstructions(
          [
            SystemProgram.transfer({
              fromPubkey: feePayer,
              toPubkey,
              lamports: 1
            })
          ],

          {
            user: { wallet, is_verified: false },
            feePayer: feePayer.toBase58()
          }
        )
      )
    })

    it('should not allow other system instructions', async function () {
      const wallet = '0x36034724e7bda41d5142efd85e1f6773460f5679'
      const feePayer = getRandomPublicKey()
      const fromPubkey = getRandomPublicKey()
      const newAccountPubkey = getRandomPublicKey()
      const programId = getRandomPublicKey()
      await assert.rejects(async () =>
        assertRelayAllowedInstructions(
          [
            SystemProgram.createAccount({
              fromPubkey,
              newAccountPubkey,
              programId,
              lamports: 1,
              space: 0
            })
          ],

          {
            user: { wallet, is_verified: false },
            feePayer: feePayer.toBase58()
          }
        )
      )
    })
  })

  describe('Other Programs', function () {
    it('allows memo instructions', async function () {
      await assertRelayAllowedInstructions([
        new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [] }),
        new TransactionInstruction({ programId: MEMO_V2_PROGRAM_ID, keys: [] })
      ])
    })

    it('allows valid secp256k1 instructions', async function () {
      await assertRelayAllowedInstructions([
        Secp256k1Program.createInstructionWithEthAddress({
          // Dummy eth address to make the encoder happy
          ethAddress: '0x8fcfa10bd3808570987dbb5b1ef4ab74400fbfda',
          message: Buffer.from(
            '68d5397bb16195ea47091010f3abb8fc6b5cdfa65f00e1f505000000005f623a33383639383d3e3530373431303135335f00b6462e955da5841b6d9e1e2529b830f00f31bf',
            'hex'
          ),
          signature: Buffer.from(
            'f89b2e6f97f95f1306b468b10b1a18df9569b07d9d7b81b241d6fc99d9ec782e4e449f5c3c63836ed52c9344d3de5c3133fead711e421af545822f09bd78cb39',
            'hex'
          ),
          recoveryId: 0
        })
      ])
    })

    it('rejects invalid secp256k1 instructions', async function () {
      await assert.rejects(async () =>
        assertRelayAllowedInstructions([
          Secp256k1Program.createInstructionWithEthAddress({
            // Dummy eth address to make the encoder happy
            ethAddress: '0x00b6462e955da5841b6d9e1e2529b830f00f31bf',
            message: Buffer.from(
              '81729dc83c157f41de7df4b72fc7e90d8d64d5aa5f00e1f505000000005f72656665727265643a353339343735333137',
              'hex'
            ),
            signature: Buffer.from(
              '00d405b277dc948f97d7b7db8648cb16590d66084ba49642fedb08380ce5027a95d0a895287a3331332e7ad13daba87eed5c70820a19ca2eb6cc0ea1eb4695ba',
              'hex'
            ),
            recoveryId: 0
          })
        ])
      )
    })

    it('does not allow other random programs', async function () {
      await assert.rejects(
        async () =>
          assertRelayAllowedInstructions([
            new TransactionInstruction({
              programId: getRandomPublicKey(),
              keys: []
            })
          ]),
        InvalidRelayInstructionError,
        'random program'
      )
    })
  })
})
