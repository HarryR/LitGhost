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
    return Number(firstIndex.toString ? firstIndex.toString() : firstIndex);
  }

  /**
   * Get a user's current balance from the blockchain
   * Returns 0 if user doesn't exist or has no balance
   */
  async getBalanceFromChain(telegramUsername: string): Promise<number> {
    const userIndex = await this.getUserIndex(telegramUsername);
    if (userIndex === 0) {
      return 0;
    }

    const { leafIdx, position } = getUserLeafInfo(userIndex);

    // Get leaf from blockchain
    const leaves = await this.contract.getLeaves([leafIdx]);
    const leaf: Leaf = {
      encryptedBalances: leaves[0].encryptedBalances.map((b: string) => arrayify(b)),
      idx: Number(leaves[0].idx),
      nonce: Number(leaves[0].nonce)
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
   * Create an UpdateBatch for calling doUpdate
   * Processes deposits, internal transactions, and payouts
   *
   * @param deposits - Deposits to process (from processDepositEvents)
   * @param transactions - Internal transfers between users
   * @param payouts - Withdrawals to Ethereum addresses
   * @returns UpdateBatch ready for doUpdate call
   */
  async createUpdateBatch(
    deposits: DepositEvent[],
    transactions: InternalTransaction[],
    payouts: Array<{ telegramUsername: string; toAddress: string; amount: bigint }>
  ): Promise<UpdateBatch> {
    // Calculate balance deltas
    const balanceDeltas = new Map<string, number>();
    const newUsers = new Set<string>();

    // Process deposits
    for (const deposit of deposits) {
      balanceDeltas.set(
        deposit.telegramUsername,
        (balanceDeltas.get(deposit.telegramUsername) || 0) + deposit.amount
      );

      // Check if user is new
      const userIndex = await this.getUserIndex(deposit.telegramUsername);
      if (userIndex === 0) {
        newUsers.add(deposit.telegramUsername);
      }
    }

    // Process internal transactions
    for (const tx of transactions) {
      balanceDeltas.set(tx.from, (balanceDeltas.get(tx.from) || 0) - tx.amount);
      balanceDeltas.set(tx.to, (balanceDeltas.get(tx.to) || 0) + tx.amount);
    }

    // Get current balances for all affected users
    const affectedUsers = new Set([
      ...balanceDeltas.keys(),
      ...payouts.map(p => p.telegramUsername)
    ]);

    const currentBalances = new Map<string, number>();
    for (const username of affectedUsers) {
      const balance = await this.getBalanceFromChain(username);
      currentBalances.set(username, balance);
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
      const amountBigInt = BigInt(payout.amount.toString());
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

    // Get current user count to assign indices to new users
    const statusForUserCount = await this.contract.getStatus();
    let currentUserCount = Number(statusForUserCount.counters.userCount.toString ? statusForUserCount.counters.userCount.toString() : statusForUserCount.counters.userCount);

    // Assign indices to new users
    const userIndices = new Map<string, number>();
    for (const username of currentBalances.keys()) {
      let userIndex = await this.getUserIndex(username);
      if (userIndex === 0) {
        // This is a new user, assign them the next available index
        userIndex = currentUserCount++;
      }
      userIndices.set(username, userIndex);
    }

    for (const [username, newBalance] of currentBalances) {
      const userIndex = userIndices.get(username)!;
      const { leafIdx, position } = getUserLeafInfo(userIndex);

      // Load current leaf from chain if not already loaded
      if (!leafUpdates.has(leafIdx) && !oldLeaves.has(leafIdx)) {
        const leaves = await this.contract.getLeaves([leafIdx]);
        const oldLeaf: Leaf = {
          encryptedBalances: leaves[0].encryptedBalances.map((b: string) => arrayify(b)),
          idx: Number(leaves[0].idx),
          nonce: Number(leaves[0].nonce)
        };
        oldLeaves.set(leafIdx, oldLeaf);

        // Clone for updating and increment nonce
        leafUpdates.set(leafIdx, {
          ...oldLeaf,
          encryptedBalances: [...oldLeaf.encryptedBalances],
          nonce: oldLeaf.nonce + 1 // Increment nonce for each update
        });
      }

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

    // Get status for opStart
    const status = await this.contract.getStatus();
    const opStart = status.counters.processedOps;
    const opCount = BigInt(deposits.length);

    // Build UpdateBatch
    const batch: UpdateBatch = {
      opStart,
      opCount,
      updates: Array.from(leafUpdates.values()),
      newUsers: newUserIds,
      payouts: payoutStructs
    };

    return batch;
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
    const userCount = Number(status.counters.userCount.toString ? status.counters.userCount.toString() : status.counters.userCount);

    return computeTranscript(batch, oldLeaves, userCount);
  }
}
