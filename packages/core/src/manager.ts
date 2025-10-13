import { keccak256, arrayify, concat, Contract } from './ethers-compat.js';
import {
  decryptDepositTo,
  getUserLeafInfo,
  decryptLeafBalance,
  type Leaf,
  type DepositTo
} from './crypto';
import {
  deriveUserKeypair,
  computeSharedSecret,
  createNamespacedKey,
  encodeUint32
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
    private contract: Contract
  ) {}

  /**
   * Compute the on-chain encrypted user ID from telegram username
   * This is what's stored in m_userIndices mapping
   */
  computeEncryptedUserId(telegramUsername: string): Uint8Array {
    return arrayify(keccak256(concat([
      this.teePrivateKey,
      Buffer.from(telegramUsername, 'utf8')
    ])));
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
    const encryptedUserId = this.computeEncryptedUserId(telegramUsername);
    const encryptedUserIdHex = '0x' + Buffer.from(encryptedUserId).toString('hex');
    const userIndices = await this.contract.getUserLeaves([encryptedUserIdHex]);
    // Handle both BigNumber and plain number returns
    const firstIndex = userIndices[0];
    return Number(firstIndex);
  }

  /**
   * Get a user's current balance from the blockchain
   * Returns 0 if user doesn't exist or has no balance
   */
  async getBalanceFromChain(telegramUsername: string): Promise<number> {
    const encryptedUserId = this.computeEncryptedUserId(telegramUsername);
    const encryptedUserIdHex = '0x' + Buffer.from(encryptedUserId).toString('hex');

    // Single call to get user info and leaf
    const userInfo = await this.contract.getUserInfo(encryptedUserIdHex);
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

    // Derive user's public key
    const { publicKey: userPublicKey } = this.deriveUserKeypair(telegramUsername);

    // Compute shared secret for balance decryption
    const sharedSecret = computeSharedSecret(this.teePrivateKey, userPublicKey);

    // Decrypt balance
    return decryptLeafBalance(leaf, position, sharedSecret);
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
    // Calculate balance deltas
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

    // Get all affected users
    const affectedUsers = new Set([
      ...balanceDeltas.keys(),
      ...payouts.map(p => p.telegramUsername)
    ]);

    // Batch fetch all user info and status in a single call
    const encryptedUserIds = Array.from(affectedUsers).map(username =>
      '0x' + Buffer.from(this.computeEncryptedUserId(username)).toString('hex')
    );

    const updateContext = await this.contract.getUpdateContext(encryptedUserIds);
    const counters = updateContext.counters;
    const userInfos = updateContext.userInfos;

    // Build maps for current balances and user indices
    const currentBalances = new Map<string, number>();
    const userIndices = new Map<string, number>();
    const newUsers = new Set<string>();

    let currentUserCount = Number(counters.userCount);

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

    // Apply deltas
    for (const [username, delta] of balanceDeltas) {
      const newBalance = (currentBalances.get(username) || 0) + delta;
      if (newBalance < 0) {
        throw new Error(`Balance would go negative for ${username}: current=${currentBalances.get(username) || 0}, delta=${delta}`);
      }      
      currentBalances.set(username, newBalance);
    }

    // Process payouts (deduct from balances)
    const payoutStructs: Payout[] = [];
    for (const payout of payouts) {
      const balance = currentBalances.get(payout.telegramUsername) || 0;

      // Payout amount comes in full token decimals, need to convert to 2 decimals for balance tracking
      // For a 6-decimal token (like USDC), divide by 10^4 to get 2 decimals
      const amountBigInt = BigInt(payout.amount);
      const amountIn2Decimals = Number(amountBigInt / 10000n);

      if (balance < amountIn2Decimals) {
        throw new Error(`Insufficient balance for ${payout.telegramUsername}: has ${balance}, needs ${amountIn2Decimals} (payout ${payout.amount})`);
      }
      currentBalances.set(payout.telegramUsername, balance - amountIn2Decimals);
      payoutStructs.push({
        toWho: payout.toAddress,
        amount: amountBigInt
      });
    }

    // Build encrypted leaf updates
    const leafUpdates = new Map<number, Leaf>();
    const oldLeaves = new Map<number, Leaf>();

    // Collect unique leaf indices we need to load
    const leafIndicesToLoad = new Set<number>();
    for (const username of currentBalances.keys()) {
      const userIndex = userIndices.get(username)!;
      const { leafIdx } = getUserLeafInfo(userIndex);
      leafIndicesToLoad.add(leafIdx);
    }

    // Batch load all required leaves
    if (leafIndicesToLoad.size > 0) {
      const leafIdxArray = Array.from(leafIndicesToLoad);
      const leaves = await this.contract.getLeaves(leafIdxArray);

      for (let i = 0; i < leafIdxArray.length; i++) {
        const leafIdx = leafIdxArray[i];
        const oldLeaf: Leaf = {
          encryptedBalances: leaves[i].encryptedBalances.map((b: string) => arrayify(b)),
          idx: Number(leaves[i].idx),
          nonce: Number(leaves[i].nonce)
        };
        oldLeaves.set(leafIdx, oldLeaf);

        // Clone for updating and increment nonce
        leafUpdates.set(leafIdx, {
          ...oldLeaf,
          encryptedBalances: [...oldLeaf.encryptedBalances],
          nonce: oldLeaf.nonce + 1 // Increment nonce for each update
        });
      }
    }

    for (const [username, newBalance] of currentBalances) {
      const userIndex = userIndices.get(username)!;
      const { leafIdx, position } = getUserLeafInfo(userIndex);

      const leaf = leafUpdates.get(leafIdx)!;

      // Derive user's public key
      const { publicKey: userPublicKey } = this.deriveUserKeypair(username);

      // Compute shared secret
      const sharedSecret = computeSharedSecret(this.teePrivateKey, userPublicKey);

      // Derive secret with nonce
      const secretWithNonce = arrayify(keccak256(concat([sharedSecret, encodeUint32(leaf.nonce)])));

      // Encrypt balance
      const balanceKey = createNamespacedKey(secretWithNonce, 'dorp.balance');
      const balanceBytes = encodeUint32(newBalance);
      const encryptedBalance = new Uint8Array(4);
      for (let i = 0; i < 4; i++) {
        encryptedBalance[i] = balanceBytes[i] ^ balanceKey[i];
      }

      leaf.encryptedBalances[position] = encryptedBalance;
    }

    // Prepare new user IDs
    const newUserIds = Array.from(newUsers).map(username =>
      this.computeEncryptedUserId(username)
    );

    // Use opStart from the batch call we already made
    const opStart = counters.processedOps;
    const opCount = BigInt(deposits.length);

    // Build UpdateBatch
    const batch: UpdateBatch = {
      opStart,
      opCount,
      nextBlock: BigInt(nextBlockToProcess),
      updates: Array.from(leafUpdates.values()),
      newUsers: newUserIds,
      payouts: payoutStructs
    };

    return batch;
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
