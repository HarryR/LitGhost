import { arrayify, Contract } from './ethers-compat.js';
import {
  decryptDepositTo,
  getUserLeafInfo,
  decryptLeafBalance,
  encryptBalance,
  decryptBalance,
  type Leaf,
  type DepositTo,
} from './crypto';
import {
  deriveUserKeypair,
  computeSharedSecret,
  namespacedHmac,
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
 * Manager context for stateless operation
 * All state is derived from on-chain data + master keys
 */
export class ManagerContext {
  constructor(
    private teePrivateKey: Uint8Array,
    private userMasterKey: Uint8Array,
    private contract: Contract,
    private chaffSecret: string = 'LitGhost.chaff.default',
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
    const baseData = Buffer.concat([
      Buffer.from(this.chaffSecret, 'utf8'),
      Buffer.from(opStart.toString()),
      Buffer.from(opCount.toString())
    ]);

    let counter = 0;
    const maxAttempts = targetChaffCount * 10; // Prevent infinite loops

    while (chaffLeaves.size < targetChaffCount && counter < maxAttempts) {
      // Hash: HMAC(teePrivateKey, namespace, baseData || counter)
      const data = Buffer.concat([baseData, Buffer.from(counter.toString())]);
      const hash = namespacedHmac(this.teePrivateKey, 'LitGhost.chaff.selection', data);

      // Convert first 4 bytes to a number and take modulo totalLeafCount
      const hashValue = new DataView(hash.buffer, hash.byteOffset, 4).getUint32(0, false);
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
   * Apply balance deltas and validate constraints
   * Returns updated balance map
   */
  private applyBalanceDeltas(
    currentBalances: Map<string, number>,
    balanceDeltas: Map<string, number>
  ): Map<string, number> {
    const updatedBalances = new Map(currentBalances);

    for (const [username, delta] of balanceDeltas) {
      const newBalance = (updatedBalances.get(username) || 0) + delta;
      if (newBalance < 0) {
        throw new Error(
          `Balance would go negative for ${username}: current=${updatedBalances.get(username) || 0}, delta=${delta}`
        );
      }
      updatedBalances.set(username, newBalance);
    }

    return updatedBalances;
  }

  /**
   * Process payouts and generate payout structs
   * Deducts amounts from balances and returns Payout array
   */
  private processPayouts(
    currentBalances: Map<string, number>,
    payouts: Array<{ telegramUsername: string; toAddress: string; amount: bigint }>
  ): { updatedBalances: Map<string, number>; payoutStructs: Payout[] } {
    const updatedBalances = new Map(currentBalances);
    const payoutStructs: Payout[] = [];

    for (const payout of payouts) {
      const balance = updatedBalances.get(payout.telegramUsername) || 0;

      // Payout amount comes in full token decimals, need to convert to 2 decimals for balance tracking
      // For a 6-decimal token (like USDC), divide by 10^4 to get 2 decimals
      const amountBigInt = BigInt(payout.amount);
      const amountIn2Decimals = Number(amountBigInt / 10000n);

      if (balance < amountIn2Decimals) {
        throw new Error(
          `Insufficient balance for ${payout.telegramUsername}: has ${balance}, needs ${amountIn2Decimals} (payout ${payout.amount})`
        );
      }

      updatedBalances.set(payout.telegramUsername, balance - amountIn2Decimals);
      payoutStructs.push({
        toWho: payout.toAddress,
        amount: amountBigInt
      });
    }

    return { updatedBalances, payoutStructs };
  }

  /**
   * Get the user's public key from their telegram username
   * This is now what's stored in m_userIndices and m_indexToUser mappings
   */
  getUserPublicKey(telegramUsername: string): Uint8Array {
    return this.deriveUserKeypair(telegramUsername).publicKey;
  }

  /**
   * Derive a user's long-term keypair deterministically
   */
  deriveUserKeypair(telegramUsername: string): { privateKey: Uint8Array; publicKey: Uint8Array } {
    return deriveUserKeypair(telegramUsername, this.userMasterKey);
  }

  /**
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

    // Decrypt balance
    const balance = decryptLeafBalance(leaf, position, sharedSecret);
    return balance;
  }

  /**
   * Process OpDeposit events from the blockchain
   * Decrypts telegram usernames and extracts deposit information
   */
  async processDepositEvents(fromBlock?: number, toBlock?: number): Promise<DepositEvent[]> {
    const filter = this.contract.filters.OpDeposit();
    const events = await this.contract.queryFilter(filter, fromBlock, toBlock);

    const deposits: DepositEvent[] = [];

    for (const event of events) {
      const args = event.args!;

      // Reconstruct DepositTo
      const depositTo: DepositTo = {
        rand: arrayify(args.randKey),
        user: arrayify(args.toUser)
      };

      // Decrypt telegram username
      const telegramUsername = decryptDepositTo(depositTo, this.teePrivateKey);

      deposits.push({
        opIndex: args.idx,
        telegramUsername,
        amount: Number(args.amount),
        blockNumber: event.blockNumber
      });
    }

    return deposits;
  }

  /**
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
   * Helper: Compute balance deltas from deposits and internal transactions
   */
  private computeBalanceDeltas(
    deposits: DepositEvent[],
    transactions: InternalTransaction[]
  ): Map<string, number> {
    const balanceDeltas = new Map<string, number>();

    // Process deposits
    for (const deposit of deposits) {
      balanceDeltas.set(
        deposit.telegramUsername,
        (balanceDeltas.get(deposit.telegramUsername) || 0) + deposit.amount
      );
    }

    // Process internal transactions
    for (const tx of transactions) {
      balanceDeltas.set(tx.from, (balanceDeltas.get(tx.from) || 0) - tx.amount);
      balanceDeltas.set(tx.to, (balanceDeltas.get(tx.to) || 0) + tx.amount);
    }

    return balanceDeltas;
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

        const { publicKey: userPublicKey } = this.deriveUserKeypair(username);
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
      const { publicKey } = this.deriveUserKeypair(username);
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
          // DEBUG: Check if this matches what we would derive locally
          // We don't know the username for this userIdx, so we can't verify here
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
   * Create an UpdateBatch for calling doUpdate
   * Processes deposits, internal transactions, and payouts
   *
   * @param deposits - Deposits to process (from processDepositEvents)
   * @param transactions - Internal transfers between users
   * @param payouts - Withdrawals to Ethereum addresses
   * @param nextBlockToProcess - The block height to resume from next time (manager's explicit decision)
   * @returns UpdateBatch ready for doUpdate call
   */
  async createUpdateBatch(
    deposits: DepositEvent[],
    transactions: InternalTransaction[],
    payouts: Array<{ telegramUsername: string; toAddress: string; amount: bigint }>,
    nextBlockToProcess: number
  ): Promise<UpdateBatch> {
    // Step 1: Calculate balance deltas from deposits and transactions
    const balanceDeltas = this.computeBalanceDeltas(deposits, transactions);

    // Step 2: Get all affected users (from deltas and payouts)
    const affectedUsers = new Set([
      ...balanceDeltas.keys(),
      ...payouts.map(p => p.telegramUsername)
    ]);

    // Step 3: Batch fetch all user info and status in a single RPC call
    const userPublicKeys = Array.from(affectedUsers).map(username =>
      '0x' + Buffer.from(this.getUserPublicKey(username)).toString('hex')
    );
    const updateContext = await this.contract.getUpdateContext(userPublicKeys);

    // Step 4: Build user state map (indices, balances, identify new users)
    const { currentBalances, userIndices, newUsers, originalUserCount, currentUserCount } =
      this.buildUserStateMap(affectedUsers, updateContext.userInfos, updateContext.counters);

    // Step 5: Apply balance deltas and validate constraints
    const updatedBalances = this.applyBalanceDeltas(currentBalances, balanceDeltas);

    // Step 6: Process payouts (convert decimals, validate, deduct from balances)
    const { updatedBalances: finalBalances, payoutStructs } =
      this.processPayouts(updatedBalances, payouts);

    // Step 7: Extract operation counters for deterministic chaff selection
    const opStart = updateContext.counters.processedOps;
    const opCount = BigInt(deposits.length);

    // Step 8: Select all leaves (real + chaff) and shuffle for privacy
    const shuffledLeafIndices = this.selectAndShuffleLeaves(
      finalBalances,
      userIndices,
      currentUserCount,
      opStart,
      opCount
    );

    // Step 9: Batch fetch all leaves and build complete public key map
    const { leaves, userIndexToPublicKey } = await this.fetchLeavesAndPublicKeys(
      shuffledLeafIndices,
      userIndices,
      originalUserCount
    );

    // Step 10: Decrypt leaves, apply balance updates, and re-encrypt
    const leafUpdates = this.decryptAndUpdateLeaves(
      shuffledLeafIndices,
      leaves,
      userIndexToPublicKey,
      finalBalances,
      userIndices,
      originalUserCount,
      currentUserCount
    );

    // Step 11: Prepare new user public keys
    const newUserPublicKeys = Array.from(newUsers).map(username =>
      this.getUserPublicKey(username)
    );

    // Step 12: Build and return UpdateBatch
    return {
      opStart,
      opCount,
      nextBlock: BigInt(nextBlockToProcess),
      updates: shuffledLeafIndices.map(idx => leafUpdates.get(idx)!),
      newUsers: newUserPublicKeys,
      payouts: payoutStructs
    };
  }

  /**
   * Process all pending deposits with intelligent batch management
   * Stateless operation: determines everything from on-chain state
   *
   * @param maxOpsPerBatch - Maximum number of deposits to process in one batch (default: 100)
   * @returns UpdateBatch ready for doUpdate call, or null if nothing to process
   */
  async processAllPendingDeposits(maxOpsPerBatch: number = 100): Promise<UpdateBatch | null> {
    const { fromBlock, toBlock } = await this.getBlockRangeToProcess();

    if (fromBlock > toBlock) {
      return null;  // Nothing to process
    }

    const allDeposits = await this.processDepositEvents(fromBlock, toBlock);

    if (allDeposits.length === 0) {
      return null;  // No deposits to process
    }

    // Take first maxOpsPerBatch deposits
    const depositsToProcess = allDeposits.slice(0, maxOpsPerBatch);

    // Determine nextBlock intelligently
    let nextBlock: number;
    const lastProcessedBlock = depositsToProcess[depositsToProcess.length - 1].blockNumber;

    if (depositsToProcess.length < allDeposits.length) {
      // We're processing a partial batch
      // Check if there are more deposits in the same block as the last one we processed
      const remainingDepositsInSameBlock = allDeposits
        .slice(maxOpsPerBatch)
        .some(d => d.blockNumber === lastProcessedBlock);

      if (remainingDepositsInSameBlock) {
        // Stay on the same block - we haven't finished processing it
        nextBlock = lastProcessedBlock;
      } else {
        // Move to next block - we finished all deposits in lastProcessedBlock
        nextBlock = lastProcessedBlock + 1;
      }
    } else {
      // We processed all available deposits - advance to next block
      nextBlock = lastProcessedBlock + 1;
    }

    return this.createUpdateBatch(depositsToProcess, [], [], nextBlock);
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
