import { keccak256, defaultAbiCoder, arrayify, hexlify } from './ethers-compat.js';
import type { Leaf } from './crypto';

/**
 * Types matching Solidity contract
 */
export interface Payout {
  toWho: string;  // address
  amount: bigint;
}

export interface UpdateBatch {
  opStart: bigint;
  opCount: bigint;
  updates: Leaf[];
  newUsers: Uint8Array[];  // bytes32[]
  payouts: Payout[];
}

/**
 * Compute the transcript hash for a doUpdate call
 * This matches the Solidity logic in Dorp.sol::doUpdate
 * Now using abi.encode throughout for cleaner code
 */
export function computeTranscript(
  batch: UpdateBatch,
  oldLeaves: Map<number, Leaf>
): Uint8Array {
  // Initialize transcript: keccak256(abi.encode(in_opStart, in_opCount, lc))
  let transcript = arrayify(keccak256(
    defaultAbiCoder.encode(
      ['uint64', 'uint64', 'uint256'],
      [batch.opStart, batch.opCount, batch.updates.length]
    )
  ));

  // Update leaves
  for (const leaf of batch.updates) {
    const oldLeaf = oldLeaves.get(leaf.idx);

    // Prepare old leaf (all zeros if not found)
    const oldEncryptedBalances = oldLeaf
      ? oldLeaf.encryptedBalances
      : Array(6).fill(new Uint8Array(4));
    const oldIdx = oldLeaf ? oldLeaf.idx : 0;
    const oldNonce = oldLeaf ? oldLeaf.nonce : 0;

    // keccak256(abi.encode(transcript, m_leaves[leaf.idx], leaf))
    transcript = arrayify(keccak256(
      defaultAbiCoder.encode(
        [
          'bytes32',
          'tuple(bytes4[6] encryptedBalances, uint32 idx, uint32 nonce)',
          'tuple(bytes4[6] encryptedBalances, uint32 idx, uint32 nonce)'
        ],
        [
          hexlify(transcript),
          {
            encryptedBalances: oldEncryptedBalances.map(b => hexlify(b)),
            idx: oldIdx,
            nonce: oldNonce
          },
          {
            encryptedBalances: leaf.encryptedBalances.map(b => hexlify(b)),
            idx: leaf.idx,
            nonce: leaf.nonce
          }
        ]
      )
    ));
  }

  // Insert new users
  const userCount = oldLeaves.size > 0
    ? Math.max(...Array.from(oldLeaves.keys()).map(idx => idx * 6 + 5)) + 1
    : 0;

  // keccak256(abi.encode(transcript, uc, nul))
  transcript = arrayify(keccak256(
    defaultAbiCoder.encode(
      ['bytes32', 'uint32', 'uint32'],
      [hexlify(transcript), userCount, batch.newUsers.length]
    )
  ));

  // Process each new user
  for (let i = 0; i < batch.newUsers.length; i++) {
    const newUserIdx = userCount + i;
    const userId = batch.newUsers[i];

    // keccak256(abi.encode(transcript, nui, in_newUsers[i]))
    transcript = arrayify(keccak256(
      defaultAbiCoder.encode(
        ['bytes32', 'uint32', 'bytes32'],
        [hexlify(transcript), newUserIdx, hexlify(userId)]
      )
    ));
  }

  // Perform payouts
  // keccak256(abi.encode(transcript, pc))
  transcript = arrayify(keccak256(
    defaultAbiCoder.encode(
      ['bytes32', 'uint256'],
      [hexlify(transcript), batch.payouts.length]
    )
  ));

  // Process each payout
  for (const payout of batch.payouts) {
    // keccak256(abi.encode(transcript, p))
    transcript = arrayify(keccak256(
      defaultAbiCoder.encode(
        ['bytes32', 'tuple(address toWho, uint256 amount)'],
        [hexlify(transcript), { toWho: payout.toWho, amount: payout.amount }]
      )
    ));
  }

  return transcript;
}

/**
 * Helper to create an empty leaf (for initialization)
 */
export function createEmptyLeaf(idx: number): Leaf {
  return {
    encryptedBalances: Array(6).fill(new Uint8Array(4)),
    idx,
    nonce: 0
  };
}
