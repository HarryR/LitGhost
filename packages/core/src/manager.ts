import { arrayify, Contract, keccak256 } from './ethers-compat.js';
import {
  decryptDepositTo,
  getUserLeafInfo,
  decryptLeafBalance,
  encryptBalance,
  decryptBalance,
  isValidTelegramUsername,
  type Leaf,
  type DepositTo,
} from './crypto';
import {
  deriveUserKeypair,
  computeSharedSecret,
  namespacedHmac,
  decodeUint32,
} from './utils';
import { computeTranscript, type UpdateBatch, type Payout } from './transcript';

/**
 * Represents a deposit event parsed from the blockchain
 */
export interface DepositEvent {
  opIndex: bigint;
  telegramUsername: string;
  amount: number;
  blockNumber: number;
  depositorAddress: string; // For refunds on balance overflow
}

/**
 * Represents a transaction between users (internal transfer)
 */
export interface InternalTransaction {
  from: string;
  to: string;
  amount: number;
}

/**
 * Represents an operation that was skipped during processing
 * Used to track deposits/transfers/payouts that couldn't be processed due to validation errors
 */
export interface SkippedOperation {
  type: 'deposit' | 'transfer' | 'payout';
  reason: string;
  details: any; // DepositEvent or InternalTransaction or payout object or partial event data
}

const NAMESPACE_CHAFF = "LitGhost.chaff";
const MAX_BALANCE = 4294967295; // uint32 max

/**
 * Manager context for stateless operation
 * All state is derived from on-chain data + master keys
 */
export class ManagerContext {
  constructor(
    private teePrivateKey: Uint8Array,
    private userMasterKey: Uint8Array,
    private contract: Contract,
    private chaffMultiplier: number = 3
  ) {}

  /**
   * Deterministically select chaff leaf indices for privacy
   * Uses consecutive hashing to generate random-looking but reproducible leaf indices
   *
   * @param totalLeafCount - Total number of leaves in the system
   * @param realLeafIndices - Set of leaf indices that have real updates (to exclude)
   * @param opStart - Starting operation index for this batch
   * @param opCount - Number of operations in this batch
   * @returns Set of chaff leaf indices to re-encrypt
   */
  private selectChaffLeaves(
    totalLeafCount: number,
    realLeafIndices: Set<number>,
    opStart: bigint,
    opCount: bigint
  ): Set<number> {
    const chaffLeaves = new Set<number>();

    // If there are no leaves or no real updates, no chaff needed
    if (totalLeafCount === 0 || realLeafIndices.size === 0) {
      return chaffLeaves;
    }

    // Calculate target number of chaff leaves
    const targetChaffCount = realLeafIndices.size * this.chaffMultiplier;

    // Base data for hashing: chaffSecret + opStart + opCount    
    let chaffSecret = namespacedHmac(this.teePrivateKey, NAMESPACE_CHAFF, Buffer.concat([
      Buffer.from(opStart.toString()),
      Buffer.from(opCount.toString())
    ]));

    let counter = 0;
    const maxAttempts = targetChaffCount * 10; // Prevent infinite loops

    while (chaffLeaves.size < targetChaffCount && counter < maxAttempts) {
      chaffSecret = arrayify(keccak256(chaffSecret));
      const hashValue = decodeUint32(chaffSecret.slice(0, 4));
      const leafIndex = hashValue % totalLeafCount;

      // Only add if it's not a real leaf and not already selected
      // With public keys on-chain, we can now re-encrypt any leaf
      if (!realLeafIndices.has(leafIndex) && !chaffLeaves.has(leafIndex)) {
        chaffLeaves.add(leafIndex);
      }

      counter++;
    }

    return chaffLeaves;
  }

  /**
   * Validate a balance against system constraints
   * Balances are stored as uint32 with 2 decimal places
   *
   * Constraints:
   * - Must be non-negative (>= 0)
   * - Must fit in uint32 (< 2^32 = 4,294,967,296)
   * - Effective max balance: 42,949,672.95 (about 42M with 2 decimals)
   *
   * @param balance - Balance to validate (in 2-decimal format)
   * @param context - Context for error message (e.g., "alice after deposit")
   * @throws Error if balance violates constraints
   */
  private validateBalance(balance: number, context: string): void {
    if (balance < 0) {
      throw new Error(
        `Balance constraint violation: negative balance for ${context}: ${balance}`
      );
    }

    if (balance > MAX_BALANCE) {
      throw new Error(
        `Balance constraint violation: overflow for ${context}: ${balance} exceeds max ${MAX_BALANCE} (${(MAX_BALANCE / 100).toFixed(2)} tokens)`
      );
    }

    if (!Number.isInteger(balance)) {
      throw new Error(
        `Balance constraint violation: non-integer balance for ${context}: ${balance}`
      );
    }
  }

  /**
   * Apply balance deltas and validate constraints
   * Returns updated balance map
   *
   * This performs fail-fast validation: if ANY balance would violate constraints,
   * the entire operation is rejected. This ensures atomicity.
   */
  private applyBalanceDeltas(
    currentBalances: Map<string, number>,
    balanceDeltas: Map<string, number>
  ): Map<string, number> {
    const updatedBalances = new Map(currentBalances);

    for (const [username, delta] of balanceDeltas) {
      const currentBalance = updatedBalances.get(username) || 0;
      const newBalance = currentBalance + delta;

      this.validateBalance(
        newBalance,
        `${username} after delta ${delta >= 0 ? '+' : ''}${delta} (current: ${currentBalance})`
      );

      updatedBalances.set(username, newBalance);
    }

    return updatedBalances;
  }

  /**
   * Process payouts and generate payout structs
   * Deducts amounts from balances and returns Payout array
   *
   * Special case: Refund payouts (with empty telegramUsername) don't deduct from balances
   * as they're refunding deposits that were never credited due to overflow
   *
   * Graceful handling: Payouts with insufficient balance are skipped and tracked in skippedOperations
   * This ensures the manager never halts due to invalid payout requests
   */
  private processPayouts(
    currentBalances: Map<string, number>,
    payouts: Array<{ telegramUsername: string; toAddress: string; amount: bigint }>
  ): {
    updatedBalances: Map<string, number>;
    payoutStructs: Payout[];
    skippedPayouts: SkippedOperation[];
  } {
    const updatedBalances = new Map(currentBalances);
    const payoutStructs: Payout[] = [];
    const skippedPayouts: SkippedOperation[] = [];

    for (const payout of payouts) {
      const amountBigInt = BigInt(payout.amount);

      // Refund payouts (empty username) don't deduct from balances
      // They refund deposits that were never credited due to overflow
      if (payout.telegramUsername === '') {
        payoutStructs.push({
          toWho: payout.toAddress,
          amount: amountBigInt
        });
        continue;
      }

      // Normal user withdrawal - deduct from balance
      const balance = updatedBalances.get(payout.telegramUsername) || 0;

      // Payout amount comes in full token decimals, need to convert to 2 decimals for balance tracking
      // For a 6-decimal token (like USDC), divide by 10^4 to get 2 decimals
      const amountIn2Decimals = Number(amountBigInt / 10000n);

      if (balance < amountIn2Decimals) {
        // Skip payout with insufficient balance - don't halt the manager
        skippedPayouts.push({
          type: 'payout' as const,
          reason: `Insufficient balance: has ${balance}, needs ${amountIn2Decimals}`,
          details: payout
        });
        continue;
      }

      updatedBalances.set(payout.telegramUsername, balance - amountIn2Decimals);
      payoutStructs.push({
        toWho: payout.toAddress,
        amount: amountBigInt
      });
    }

    return { updatedBalances, payoutStructs, skippedPayouts };
  }

  /**
   * Get the user's public key from their telegram username
   * This is now what's stored in m_userIndices and m_indexToUser mappings
   *
   * Note: This performs secp256k1 ECDH operations and takes ~0.5-2ms per call.
   * Consider caching results when processing the same user multiple times.
   */
  getUserPublicKey(telegramUsername: string): Uint8Array {
    return deriveUserKeypair(telegramUsername, this.userMasterKey).publicKey;
  }

  /**
   * MAKES CONTRACT CALLS
   * Get a user's current user index from the blockchain
   * Returns 0 if user doesn't exist yet
   */
  async getUserIndex(telegramUsername: string): Promise<number> {
    const userPublicKey = this.getUserPublicKey(telegramUsername);
    const userPublicKeyHex = '0x' + Buffer.from(userPublicKey).toString('hex');
    const userIndices = await this.contract.getUserLeaves([userPublicKeyHex]);
    // Handle both BigNumber and plain number returns
    const firstIndex = userIndices[0];
    return Number(firstIndex);
  }

  /**
   * MAKES CONTRACT CALLS
   * Get a user's current balance from the blockchain
   * Returns 0 if user doesn't exist or has no balance
   */
  async getBalanceFromChain(telegramUsername: string): Promise<number> {
    const userPublicKey = this.getUserPublicKey(telegramUsername);
    const userPublicKeyHex = '0x' + Buffer.from(userPublicKey).toString('hex');

    // Single call to get user info and leaf
    const userInfo = await this.contract.getUserInfo(userPublicKeyHex);
    const userIndex = Number(userInfo.userIndex);

    if (userIndex === 0) {
      return 0;
    }

    const { position } = getUserLeafInfo(userIndex);

    const leaf: Leaf = {
      encryptedBalances: userInfo.leaf.encryptedBalances.map((b: string) => arrayify(b)),
      idx: Number(userInfo.leaf.idx),
      nonce: Number(userInfo.leaf.nonce)
    };

    // Compute shared secret for balance decryption
    const sharedSecret = computeSharedSecret(this.teePrivateKey, userPublicKey);
    return decryptLeafBalance(leaf, position, sharedSecret);
  }

  /**
   * MAKES CONTRACT CALLS
   * Process OpDeposit events from the blockchain in a given block range
   * Decrypts telegram usernames and extracts deposit information
   *
   * Handles validation errors gracefully - invalid/corrupted deposits are tracked separately
   * for refunding, ensuring the step() function never fails.
   *
   * @param fromBlock - Starting block number (inclusive)
   * @param toBlock - Ending block number (inclusive) or 'latest'
   * @param lastProcessedOpIndex - Skip deposits with opIndex <= this value
   * @returns Object with valid deposits and invalid deposits (for refunding)
   */
  async processDepositEvents(
    fromBlock: number,
    toBlock: number | string,
    lastProcessedOpIndex: bigint
  ): Promise<{
    validDeposits: DepositEvent[];
    invalidDeposits: Array<{ event: any; reason: string }>;
  }> {
    const filter = this.contract.filters.OpDeposit();
    const events = await this.contract.queryFilter(filter, fromBlock, toBlock);

    const validDeposits: DepositEvent[] = [];
    const invalidDeposits: Array<{ event: any; reason: string }> = [];

    for (const event of events) {
      // Skip removed events (chain reorgs)
      if (event.removed) {
        continue;
      }

      const args = event.args!;

      // Skip already processed operations
      if (args.idx <= lastProcessedOpIndex) {
        continue;
      }

      // Extract depositor address for potential refunds
      const depositorAddress = args.from;
      const amount = Number(args.amount);
      const opIndex = args.idx;
      const blockNumber = event.blockNumber;

      try {
        // Reconstruct DepositTo
        const depositTo: DepositTo = {
          rand: arrayify(args.randKey),
          user: arrayify(args.toUser)
        };

        // Decrypt telegram username (may throw if corrupted)
        const telegramUsername = decryptDepositTo(depositTo, this.teePrivateKey);

        // Validate username format
        if (!isValidTelegramUsername(telegramUsername)) {
          invalidDeposits.push({
            event: {
              opIndex,
              amount,
              depositorAddress,
              blockNumber,
              decryptedUsername: telegramUsername
            },
            reason: `Invalid telegram username format: "${telegramUsername}"`
          });
          continue;
        }

        // Valid deposit
        validDeposits.push({
          opIndex,
          telegramUsername,
          amount,
          blockNumber,
          depositorAddress
        });

      } catch (error) {
        // Decryption failed or other error - mark for refund
        invalidDeposits.push({
          event: {
            opIndex,
            amount,
            depositorAddress,
            blockNumber
          },
          reason: `Failed to decrypt deposit: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    return { validDeposits, invalidDeposits };
  }

  /**
   * MAKES CONTRACT CALLS
   * Get the block range to process deposits from
   * Returns [fromBlock, toBlock] based on contract state
   */
  async getBlockRangeToProcess(toBlock?: number): Promise<{ fromBlock: number; toBlock: number }> {
    const context = await this.contract.getUpdateContext([]);
    const lastProcessedBlock = Number(context.counters.lastProcessedBlock);

    const fromBlock = lastProcessedBlock + 1;  // Resume from next block after last processed
    const currentBlock = await this.contract.provider.getBlockNumber();
    const endBlock = toBlock ?? currentBlock;

    return { fromBlock, toBlock: endBlock };
  }

  /**
   * Helper: Compute balance deltas from deposits and internal transactions with overflow handling
   *
   * Overflow handling strategy:
   * - Deposits: Cap at MAX_BALANCE, generate refund payout for excess back to depositor
   * - Internal transfers: Cap transfer amount to what recipient can receive (no refund needed)
   *
   * Validation strategy:
   * - Internal transfers to invalid usernames: Skip silently, track in skippedOperations
   * - This ensures step() never fails due to validation errors
   *
   * @returns Object with balance deltas, auto-generated refund payouts, and skipped operations
   */
  private computeBalanceDeltasWithOverflowHandling(
    deposits: DepositEvent[],
    transactions: InternalTransaction[],
    currentBalances: Map<string, number>
  ): {
    balanceDeltas: Map<string, number>;
    autoRefundPayouts: Array<{ toAddress: string; amount: bigint }>;
    skippedOperations: SkippedOperation[];
  } {
    const balanceDeltas = new Map<string, number>();
    const autoRefundPayouts: Array<{ toAddress: string; amount: bigint }> = [];
    const skippedOperations: SkippedOperation[] = [];

    // Process deposits with overflow detection
    for (const deposit of deposits) {
      const currentBalance = currentBalances.get(deposit.telegramUsername) || 0;
      const cumulativeDelta = balanceDeltas.get(deposit.telegramUsername) || 0;
      const proposedBalance = currentBalance + cumulativeDelta + deposit.amount;

      if (proposedBalance > MAX_BALANCE) {
        // Cap at max, refund excess
        const roomAvailable = MAX_BALANCE - (currentBalance + cumulativeDelta);
        const accepted = Math.max(0, roomAvailable);
        const excess = deposit.amount - accepted;

        if (accepted > 0) {
          balanceDeltas.set(
            deposit.telegramUsername,
            cumulativeDelta + accepted
          );
        }

        // Generate refund payout for excess (convert 2 decimals back to 6 decimals)
        if (excess > 0) {
          const refundAmountFullDecimals = BigInt(excess) * 10000n;
          autoRefundPayouts.push({
            toAddress: deposit.depositorAddress,
            amount: refundAmountFullDecimals
          });
        }
      } else {
        balanceDeltas.set(
          deposit.telegramUsername,
          cumulativeDelta + deposit.amount
        );
      }
    }

    // Process internal transactions with validation and automatic capping
    for (const tx of transactions) {
      // Validate recipient username
      if (!isValidTelegramUsername(tx.to)) {
        skippedOperations.push({
          type: 'transfer',
          reason: `Invalid recipient username: "${tx.to}"`,
          details: tx
        });
        continue; // Skip this transfer, sender keeps funds
      }

      // Also validate sender (defensive check)
      if (!isValidTelegramUsername(tx.from)) {
        skippedOperations.push({
          type: 'transfer',
          reason: `Invalid sender username: "${tx.from}"`,
          details: tx
        });
        continue;
      }

      const senderBalance =
        (currentBalances.get(tx.from) || 0) + (balanceDeltas.get(tx.from) || 0);
      const recipientBalance =
        (currentBalances.get(tx.to) || 0) + (balanceDeltas.get(tx.to) || 0);

      // Cap transfer amount to what recipient can receive
      const maxCanReceive = MAX_BALANCE - recipientBalance;
      const cappedByRecipient = Math.min(tx.amount, maxCanReceive);

      // Also cap by sender's available balance (prevent negative)
      const actualTransfer = Math.min(cappedByRecipient, senderBalance);

      if (actualTransfer > 0) {
        balanceDeltas.set(tx.from, (balanceDeltas.get(tx.from) || 0) - actualTransfer);
        balanceDeltas.set(tx.to, (balanceDeltas.get(tx.to) || 0) + actualTransfer);
      }
    }

    return { balanceDeltas, autoRefundPayouts, skippedOperations };
  }

  /**
   * Helper: Build user state map from update context
   * Returns user indices, current balances, and identifies new users
   */
  private buildUserStateMap(
    affectedUsers: Set<string>,
    userInfos: any[],
    counters: any
  ): {
    currentBalances: Map<string, number>;
    userIndices: Map<string, number>;
    newUsers: Set<string>;
    originalUserCount: number;
    currentUserCount: number;
  } {

    const currentBalances = new Map<string, number>();
    const userIndices = new Map<string, number>();
    const newUsers = new Set<string>();
    const originalUserCount = Number(counters.userCount);
    let currentUserCount = originalUserCount;

    const affectedUsersArray = Array.from(affectedUsers);
    for (let i = 0; i < affectedUsersArray.length; i++) {
      const username = affectedUsersArray[i];
      const userInfo = userInfos[i];
      const userIndex = Number(userInfo.userIndex);

      if (userIndex === 0) {
        // New user
        newUsers.add(username);
        const newUserIndex = currentUserCount++;
        userIndices.set(username, newUserIndex);
        currentBalances.set(username, 0);
      } else {
        // Existing user - decrypt current balance
        userIndices.set(username, userIndex);

        const { position } = getUserLeafInfo(userIndex);
        const leaf: Leaf = {
          encryptedBalances: userInfo.leaf.encryptedBalances.map((b: string) => arrayify(b)),
          idx: Number(userInfo.leaf.idx),
          nonce: Number(userInfo.leaf.nonce)
        };

        const userPublicKey = this.getUserPublicKey(username);
        const sharedSecret = computeSharedSecret(this.teePrivateKey, userPublicKey);
        const balance = decryptLeafBalance(leaf, position, sharedSecret);

        currentBalances.set(username, balance);
      }
    }

    return { currentBalances, userIndices, newUsers, originalUserCount, currentUserCount };
  }

  /**
   * Helper: Select all leaves (real + chaff) and shuffle for privacy
   */
  private selectAndShuffleLeaves(
    currentBalances: Map<string, number>,
    userIndices: Map<string, number>,
    currentUserCount: number,
    opStart: bigint,
    opCount: bigint
  ): number[] {

    // Find all leaves that need updating (real)
    const realLeafIndices = new Set<number>();
    for (const username of currentBalances.keys()) {
      const userIndex = userIndices.get(username)!;
      const { leafIdx } = getUserLeafInfo(userIndex);
      realLeafIndices.add(leafIdx);
    }

    // Calculate total number of leaves in the system
    const totalLeafCount = Math.ceil(currentUserCount / 6);

    // Select chaff leaves for privacy (deterministic based on opStart/opCount)
    const chaffLeafIndices = this.selectChaffLeaves(
      totalLeafCount,
      realLeafIndices,
      opStart,
      opCount
    );

    // Combine all leaf indices (real + chaff)
    const allLeafIndices = new Set([...realLeafIndices, ...chaffLeafIndices]);

    // Randomize leaf order for additional privacy (deterministic shuffle based on opStart)
    const shuffled = Array.from(allLeafIndices).sort((a, b) => {
      const hashA = namespacedHmac(this.teePrivateKey, 'LitGhost.leaf.order',
        Buffer.concat([Buffer.from(opStart.toString()), Buffer.from(a.toString())]));
      const hashB = namespacedHmac(this.teePrivateKey, 'LitGhost.leaf.order',
        Buffer.concat([Buffer.from(opStart.toString()), Buffer.from(b.toString())]));
      return Buffer.compare(hashA, hashB);
    });

    return shuffled;
  }

  /**
   * Helper: Fetch leaves and build complete user public key map
   */
  private async fetchLeavesAndPublicKeys(
    shuffledLeafIndices: number[],
    userIndices: Map<string, number>,
    originalUserCount: number
  ): Promise<{
    leaves: Leaf[];
    userIndexToPublicKey: Map<number, Uint8Array>;
  }> {
    if (shuffledLeafIndices.length === 0) {
      return { leaves: [], userIndexToPublicKey: new Map() };
    }

    // Batch load all leaves
    const leavesRaw = await this.contract.getLeaves(shuffledLeafIndices);
    const leaves: Leaf[] = leavesRaw.map((leaf: any) => ({
      encryptedBalances: leaf.encryptedBalances.map((b: string) => arrayify(b)),
      idx: Number(leaf.idx),
      nonce: Number(leaf.nonce)
    }));

    // Build map of userIndex → publicKey
    // First, add public keys for users we already know (from affected users in this batch)
    const userIndexToPublicKey = new Map<number, Uint8Array>();
    for (const [username, userIdx] of userIndices) {
      const publicKey = this.getUserPublicKey(username);
      userIndexToPublicKey.set(userIdx, publicKey);
    }

    // Collect user indices we don't know about (need to fetch from contract)
    // But only for existing users - new users won't have public keys on-chain yet
    const unknownUserIndices: number[] = [];
    for (const leafIdx of shuffledLeafIndices) {
      for (let position = 0; position < 6; position++) {
        const userIndex = leafIdx * 6 + position;
        // Only fetch if: user is EXISTING (< originalUserCount) and not already in our map
        if (userIndex < originalUserCount && !userIndexToPublicKey.has(userIndex)) {
          unknownUserIndices.push(userIndex);
        }
      }
    }

    // Batch fetch public keys for unknown existing users
    if (unknownUserIndices.length > 0) {
      const publicKeys = await this.contract.getUserPublicKeys(unknownUserIndices);
      for (let i = 0; i < unknownUserIndices.length; i++) {
        const pk = arrayify(publicKeys[i]);
        const userIdx = unknownUserIndices[i];
        // Verify we got a valid public key (not zeros)
        if (pk.some(byte => byte !== 0)) {
          userIndexToPublicKey.set(userIdx, pk);
        } else {
        }
      }
    }

    return { leaves, userIndexToPublicKey };
  }

  /**
   * Helper: Decrypt leaves, apply balance updates, and re-encrypt
   */
  private decryptAndUpdateLeaves(
    shuffledLeafIndices: number[],
    leaves: Leaf[],
    userIndexToPublicKey: Map<number, Uint8Array>,
    currentBalances: Map<string, number>,
    userIndices: Map<string, number>,
    originalUserCount: number,
    currentUserCount: number
  ): Map<number, Leaf> {

    const leafUpdates = new Map<number, Leaf>();

    for (let i = 0; i < shuffledLeafIndices.length; i++) {
      const leafIdx = shuffledLeafIndices[i];
      const oldLeaf = leaves[i];

      // Decrypt all balances in this leaf
      const decryptedBalances: number[] = [];
      for (let position = 0; position < 6; position++) {
        const userIndex = leafIdx * 6 + position;
        // Only decrypt EXISTING users (those that were on-chain before this batch)
        // New users (>= originalUserCount) don't have encrypted balances yet
        if (userIndex < originalUserCount) {
          const userPublicKey = userIndexToPublicKey.get(userIndex);
          if (userPublicKey) {
            const sharedSecret = computeSharedSecret(this.teePrivateKey, userPublicKey);
            const balance = decryptBalance(
              oldLeaf.encryptedBalances[position],
              sharedSecret,
              oldLeaf.nonce
            );
            decryptedBalances[position] = balance;
          } else {
            // No public key available - this shouldn't happen in practice
            decryptedBalances[position] = 0;
          }
        } else if (userIndex < currentUserCount) {
          // New user in this batch - start with balance 0 (will be updated below)
          decryptedBalances[position] = 0;
        } else {
          // Empty slot (beyond current user count)
          decryptedBalances[position] = 0;
        }
      }

      // Apply balance updates from deltas (only for real updates)
      for (const [username, newBalance] of currentBalances) {
        const userIndex = userIndices.get(username)!;
        const { leafIdx: targetLeafIdx, position } = getUserLeafInfo(userIndex);
        if (targetLeafIdx === leafIdx) {
          decryptedBalances[position] = newBalance;
        }
      }

      // Re-encrypt all balances with new nonce
      const newNonce = oldLeaf.nonce + 1;
      const newEncryptedBalances: Uint8Array[] = [];
      for (let position = 0; position < 6; position++) {
        const userIndex = leafIdx * 6 + position;
        if (userIndex < currentUserCount) {
          const userPublicKey = userIndexToPublicKey.get(userIndex);
          if (userPublicKey) {
            const sharedSecret = computeSharedSecret(this.teePrivateKey, userPublicKey);
            const encryptedBalance = encryptBalance(
              decryptedBalances[position],
              sharedSecret,
              newNonce
            );
            newEncryptedBalances[position] = encryptedBalance;
          } else {
            // No public key - leave as zeros (shouldn't happen if decrypt worked)
            newEncryptedBalances[position] = new Uint8Array(4);
          }
        } else {
          newEncryptedBalances[position] = new Uint8Array(4); // Empty slot
        }
      }

      leafUpdates.set(leafIdx, {
        encryptedBalances: newEncryptedBalances,
        idx: leafIdx,
        nonce: newNonce
      });
    }

    return leafUpdates;
  }

  /**
   * MAKES CONTRACT CALLS
   * Create an UpdateBatch for calling doUpdate
   * Processes deposits, internal transactions, and payouts
   *
   * Handles all error cases gracefully to ensure step() never fails
   *
   * @param deposits - Deposits to process (from processDepositEvents)
   * @param transactions - Internal transfers between users
   * @param payouts - Withdrawals to Ethereum addresses
   * @param nextBlockToProcess - The block height to resume from next time (manager's explicit decision)
   * @param invalidDeposits - Invalid/corrupted deposits to refund
   * @returns UpdateBatch and skipped operations metadata
   */
  async createUpdateBatch(
    deposits: DepositEvent[],
    transactions: InternalTransaction[],
    payouts: Array<{ telegramUsername: string; toAddress: string; amount: bigint }>,
    nextBlockToProcess: number,
    invalidDeposits: Array<{ event: any; reason: string }> = []
  ): Promise<{
    batch: UpdateBatch;
    skippedOperations: SkippedOperation[];
  }> {
    // Step 1: Get preliminary affected users (to fetch current balances)
    const preliminaryAffectedUsers = new Set([
      ...deposits.map(d => d.telegramUsername),
      ...transactions.flatMap(t => [t.from, t.to]),
      ...payouts.map(p => p.telegramUsername).filter(u => u !== '') // Filter out refund payouts
    ]);

    // Step 2: Batch fetch user info to get current balances
    const userPublicKeys = Array.from(preliminaryAffectedUsers).map(username =>
      '0x' + Buffer.from(this.getUserPublicKey(username)).toString('hex')
    );
    const updateContext = await this.contract.getUpdateContext(userPublicKeys);

    // Step 3: Build preliminary user state map
    const { currentBalances, userIndices, newUsers, originalUserCount } =
      this.buildUserStateMap(preliminaryAffectedUsers, updateContext.userInfos, updateContext.counters);

    // Step 4: Calculate balance deltas WITH overflow and validation handling
    const { balanceDeltas, autoRefundPayouts, skippedOperations } = this.computeBalanceDeltasWithOverflowHandling(
      deposits,
      transactions,
      currentBalances
    );

    // Step 5: Generate refund payouts for invalid deposits
    const invalidDepositRefunds = invalidDeposits.map(invalid => ({
      telegramUsername: '', // Not used for refunds - empty username
      toAddress: invalid.event.depositorAddress,
      amount: BigInt(invalid.event.amount) * 10000n // Convert 2 decimals back to 6
    }));

    // Step 6: Merge ALL payout types: overflow refunds + invalid deposit refunds + user payouts
    const allPayouts = [
      ...autoRefundPayouts.map(r => ({
        telegramUsername: '', // Not used for refunds - empty username
        toAddress: r.toAddress,
        amount: r.amount
      })),
      ...invalidDepositRefunds,
      ...payouts
    ];

    // Step 6: Apply balance deltas and validate constraints
    const updatedBalances = this.applyBalanceDeltas(currentBalances, balanceDeltas);

    // Step 7: Process payouts (convert decimals, validate, deduct from balances)
    const { updatedBalances: finalBalances, payoutStructs, skippedPayouts } =
      this.processPayouts(updatedBalances, allPayouts);

    // Step 8: Filter final balances to only include users actually affected by valid operations
    // This is critical: if all operations were skipped, we shouldn't update any leaves
    // Only include users who:
    // - Received deposits
    // - Were involved in valid (non-skipped) transfers (have balance deltas)
    // - Have payouts deducted from their balance
    const actuallyAffectedUsers = new Set([
      ...deposits.map(d => d.telegramUsername),
      ...balanceDeltas.keys(),  // Users with actual balance changes from valid transfers
      ...payouts.map(p => p.telegramUsername).filter(u => u !== '') // Users with payouts (not refunds)
    ]);

    const filteredFinalBalances = new Map<string, number>();
    const filteredUserIndices = new Map<string, number>();
    const filteredNewUsers = new Set<Uint8Array>();

    for (const username of actuallyAffectedUsers) {
      if (finalBalances.has(username)) {
        filteredFinalBalances.set(username, finalBalances.get(username)!);
        filteredUserIndices.set(username, userIndices.get(username)!);

        // Check if this is a new user (newUsers contains usernames as strings)
        if (newUsers.has(username)) {
          const userPubKey = this.getUserPublicKey(username);
          filteredNewUsers.add(userPubKey);
        }
      }
    }

    // Recalculate current user count based on filtered users
    const filteredCurrentUserCount = originalUserCount + filteredNewUsers.size;

    // Step 9: Extract operation counters for deterministic chaff selection
    const opStart = updateContext.counters.processedOps;
    const opCount = BigInt(deposits.length);

    // Step 10: Select all leaves (real + chaff) and shuffle for privacy
    const shuffledLeafIndices = this.selectAndShuffleLeaves(
      filteredFinalBalances,
      filteredUserIndices,
      filteredCurrentUserCount,
      opStart,
      opCount
    );

    // Step 11: Batch fetch all leaves and build complete public key map
    const { leaves, userIndexToPublicKey } = await this.fetchLeavesAndPublicKeys(
      shuffledLeafIndices,
      filteredUserIndices,
      originalUserCount
    );

    // Step 12: Decrypt leaves, apply balance updates, and re-encrypt
    const leafUpdates = this.decryptAndUpdateLeaves(
      shuffledLeafIndices,
      leaves,
      userIndexToPublicKey,
      filteredFinalBalances,
      filteredUserIndices,
      originalUserCount,
      filteredCurrentUserCount
    );

    // Step 13: Build UpdateBatch
    const batch: UpdateBatch = {
      opStart,
      opCount,
      nextBlock: BigInt(nextBlockToProcess),
      updates: shuffledLeafIndices.map(idx => leafUpdates.get(idx)!),
      newUsers: Array.from(filteredNewUsers), // Already Uint8Array public keys
      payouts: payoutStructs
    };

    // Step 13: Combine all skipped operations (invalid deposits + invalid transfers + insufficient balance payouts)
    const allSkippedOperations: SkippedOperation[] = [
      ...skippedOperations,
      ...invalidDeposits.map(inv => ({
        type: 'deposit' as const,
        reason: inv.reason,
        details: inv.event
      })),
      ...skippedPayouts
    ];

    return { batch, skippedOperations: allSkippedOperations };
  }

  /**
   * MAKES CONTRACT CALLS
   * Collect pending deposits with time-limited block scanning
   * Designed for time-limited cron jobs (30s execution window)
   *
   * Strategy:
   * - Iteratively scans blocks in chunks until time budget exhausted, current block reached, or maxDeposits collected
   * - Returns deposits and recommended nextBlock cursor position
   * - Handles invalid/corrupted deposits gracefully by tracking them for refunding
   * - This prevents having to scan weeks of blocks after periods of inactivity
   *
   * @param maxDeposits - Maximum number of deposits to collect (default: 10)
   * @param blockChunkSize - Number of blocks to fetch per iteration (default: 1000)
   * @param timeBudgetMs - Maximum time to spend scanning for deposits in milliseconds (default: 5000ms = 5s)
   * @returns Object with valid deposits, invalid deposits (for refunding), and nextBlock cursor position
   */
  async collectPendingDeposits(
    maxDeposits: number = 10,
    blockChunkSize: number = 1000,
    timeBudgetMs: number = 5000
  ): Promise<{
    deposits: DepositEvent[];
    invalidDeposits: Array<{ event: any; reason: string }>;
    nextBlock: number;
  }> {
    const startTime = Date.now();

    // Get current state from contract
    const context = await this.contract.getUpdateContext([]);
    const lastProcessedBlock = Number(context.counters.lastProcessedBlock);
    const lastProcessedOpIndex = context.counters.processedOps;
    const currentBlock = await this.contract.provider.getBlockNumber();

    // If we're already caught up, return empty deposits and advance cursor to current block
    if (lastProcessedBlock >= currentBlock) {
      return { deposits: [], invalidDeposits: [], nextBlock: currentBlock };
    }

    // Iteratively fetch deposits in chunks until we hit one of our limits
    const collectedDeposits: DepositEvent[] = [];
    const allInvalidDeposits: Array<{ event: any; reason: string }> = [];
    let scanCursor = lastProcessedBlock;

    while (
      collectedDeposits.length < maxDeposits &&
      scanCursor < currentBlock &&
      (Date.now() - startTime) < timeBudgetMs
    ) {
      const chunkEnd = Math.min(scanCursor + blockChunkSize, currentBlock);

      const { validDeposits, invalidDeposits } = await this.processDepositEvents(
        scanCursor,
        chunkEnd,
        lastProcessedOpIndex
      );

      collectedDeposits.push(...validDeposits);
      allInvalidDeposits.push(...invalidDeposits);

      // If we've collected enough, break early
      if (collectedDeposits.length >= maxDeposits) {
        break;
      }

      // Move to next chunk
      scanCursor = chunkEnd + 1;
    }

    // If no deposits found in any chunks, advance to where we scanned up to
    if (collectedDeposits.length === 0) {
      return { deposits: [], invalidDeposits: allInvalidDeposits, nextBlock: scanCursor };
    }

    // Take first maxDeposits deposits (in case we collected more than needed)
    const depositsToProcess = collectedDeposits.slice(0, maxDeposits);

    // Determine nextBlock intelligently
    let nextBlock: number;
    const lastProcessedDepositBlock = depositsToProcess[depositsToProcess.length - 1].blockNumber;

    if (depositsToProcess.length < collectedDeposits.length) {
      // We're processing a partial batch - check if there are more deposits in the same block
      const remainingDepositsInSameBlock = collectedDeposits
        .slice(maxDeposits)
        .some(d => d.blockNumber === lastProcessedDepositBlock);

      if (remainingDepositsInSameBlock) {
        // Stay on the same block - we haven't finished processing it
        nextBlock = lastProcessedDepositBlock;
      } else {
        // Move to next block - we finished all deposits in lastProcessedDepositBlock
        nextBlock = lastProcessedDepositBlock + 1;
      }
    } else {
      // We processed all collected deposits
      nextBlock = lastProcessedDepositBlock + 1;
    }

    return { deposits: depositsToProcess, invalidDeposits: allInvalidDeposits, nextBlock };
  }

  /**
   * MAKES CONTRACT CALLS
   * Execute a single manager step: collect deposits, apply transactions/payouts, create update batch
   * This is the main orchestration function for the manager's cron job
   *
   * IMPORTANT: This function NEVER fails - all errors are handled gracefully:
   * - Invalid/corrupted deposits → Automatically refunded
   * - Invalid transfer recipients → Skipped, tracked in skippedOperations
   * - Balance overflows → Automatically refunded or capped
   *
   * @param transactions - Internal transfers between users
   * @param payouts - Withdrawals to Ethereum addresses
   * @param maxDeposits - Maximum number of deposits to process (default: 10)
   * @param blockChunkSize - Number of blocks to scan per iteration (default: 1000)
   * @param timeBudgetMs - Time budget for deposit scanning in ms (default: 5000ms)
   * @returns UpdateBatch ready for doUpdate call and metadata about skipped operations
   */
  async step(
    transactions: InternalTransaction[] = [],
    payouts: Array<{ telegramUsername: string; toAddress: string; amount: bigint }> = [],
    maxDeposits: number = 10,
    blockChunkSize: number = 1000,
    timeBudgetMs: number = 5000
  ): Promise<{
    batch: UpdateBatch;
    skippedOperations: SkippedOperation[];
  }> {
    // Collect pending deposits within time budget
    const { deposits, invalidDeposits, nextBlock } = await this.collectPendingDeposits(
      maxDeposits,
      blockChunkSize,
      timeBudgetMs
    );

    // Create update batch combining deposits, transactions, and payouts
    // Handles invalid deposits and validation errors gracefully
    return this.createUpdateBatch(deposits, transactions, payouts, nextBlock, invalidDeposits);
  }

  /**
   * Compute transcript hash for an update batch
   * This wraps the core computeTranscript function
   */
  async computeTranscriptForBatch(batch: UpdateBatch): Promise<Uint8Array> {
    // Load old leaves
    const oldLeaves = new Map<number, Leaf>();
    const leafIndices = batch.updates.map(l => l.idx);

    if (leafIndices.length > 0) {
      const leaves = await this.contract.getLeaves(leafIndices);
      for (let i = 0; i < leaves.length; i++) {
        oldLeaves.set(leafIndices[i], {
          encryptedBalances: leaves[i].encryptedBalances.map((b: string) => arrayify(b)),
          idx: Number(leaves[i].idx),
          nonce: Number(leaves[i].nonce)
        });
      }
    }

    // Get current user count from contract
    const status = await this.contract.getStatus();
    const userCount = Number(status.counters.userCount);

    return computeTranscript(batch, oldLeaves, userCount);
  }
}
