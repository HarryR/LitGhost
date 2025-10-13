import { arrayify, Contract } from './ethers-compat.js';
import {
  getUserLeafInfo,
  decryptLeafBalance,
  type Leaf
} from './crypto';
import {
  computeSharedSecret
} from './utils';

/**
 * Represents a balance update event
 */
export interface BalanceUpdate {
  blockNumber: number;
  balance: number;
  nonce: number;
  timestamp: number;
  transactionHash: string;
}

/**
 * Options for watching balance updates
 */
export interface WatchBalanceOptions {
  /** Maximum number of events to process (default: 1000) */
  maxEvents?: number;
  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
  /** Starting block number (default: current block) */
  fromBlock?: number | 'latest';
}

/**
 * User client for querying and watching balances
 * Users hold their private key and can decrypt their own balances
 */
export class UserClient {
  private userIndex: number | null = null;
  private leafIdx: number | null = null;
  private position: number | null = null;

  constructor(
    private userPrivateKey: Uint8Array,
    private encryptedUserId: Uint8Array,
    private teePublicKey: Uint8Array,
    private contract: Contract
  ) {}

  /**
   * Get the user's index from the blockchain
   * Cached after first call
   */
  async getUserIndex(): Promise<number> {
    if (this.userIndex !== null) {
      return this.userIndex;
    }

    const encryptedUserIdHex = '0x' + Buffer.from(this.encryptedUserId).toString('hex');
    const userIndices = await this.contract.getUserLeaves([encryptedUserIdHex]);
    // Handle both BigNumber and plain number returns
    const firstIndex = userIndices[0];
    this.userIndex = Number(firstIndex.toString ? firstIndex.toString() : firstIndex);

    if (this.userIndex === 0) {
      throw new Error('User not registered on-chain yet');
    }

    // Calculate and cache leaf info
    const leafInfo = getUserLeafInfo(this.userIndex);
    this.leafIdx = leafInfo.leafIdx;
    this.position = leafInfo.position;

    return this.userIndex;
  }

  /**
   * Get the user's leaf index
   */
  async getLeafIndex(): Promise<number> {
    if (this.leafIdx !== null) {
      return this.leafIdx;
    }
    await this.getUserIndex();
    return this.leafIdx!;
  }

  /**
   * Get the user's position within their leaf (0-5)
   */
  async getPosition(): Promise<number> {
    if (this.position !== null) {
      return this.position;
    }
    await this.getUserIndex();
    return this.position!;
  }

  /**
   * Unpack a leaf from on-chain packed format
   */
  private unpackLeaf(packedLeaf: string): Leaf {
    const bytes = arrayify(packedLeaf);

    // First 24 bytes: 6x 4-byte encrypted balances
    const encryptedBalances: Uint8Array[] = [];
    for (let i = 0; i < 6; i++) {
      encryptedBalances.push(bytes.slice(i * 4, (i + 1) * 4));
    }

    // Next 4 bytes: idx (uint32)
    const idxBytes = bytes.slice(24, 28);
    const idx = (idxBytes[0] << 24) | (idxBytes[1] << 16) | (idxBytes[2] << 8) | idxBytes[3];

    // Last 4 bytes: nonce (uint32)
    const nonceBytes = bytes.slice(28, 32);
    const nonce = (nonceBytes[0] << 24) | (nonceBytes[1] << 16) | (nonceBytes[2] << 8) | nonceBytes[3];

    return {
      encryptedBalances,
      idx,
      nonce
    };
  }

  /**
   * Decrypt a balance from a leaf
   */
  private decryptBalance(leaf: Leaf): number {
    const position = this.position!;
    const sharedSecret = computeSharedSecret(this.userPrivateKey, this.teePublicKey);
    return decryptLeafBalance(leaf, position, sharedSecret);
  }

  /**
   * Get the user's current balance from the blockchain
   */
  async getBalance(): Promise<number> {
    await this.getUserIndex(); // Ensure initialized

    const leafIdx = this.leafIdx!;

    // Get leaf from blockchain
    const leaves = await this.contract.getLeaves([leafIdx]);
    const leaf: Leaf = {
      encryptedBalances: leaves[0].encryptedBalances.map((b: string) => arrayify(b)),
      idx: Number(leaves[0].idx),
      nonce: Number(leaves[0].nonce)
    };

    return this.decryptBalance(leaf);
  }

  /**
   * Watch for balance updates via LeafChange events
   * Returns an async generator that yields balance updates
   *
   * @example
   * ```typescript
   * for await (const update of client.watchBalanceUpdates({ maxEvents: 10, timeoutMs: 30000 })) {
   *   console.log(`Balance: ${update.balance}, Block: ${update.blockNumber}`);
   * }
   * ```
   */
  async *watchBalanceUpdates(
    options: WatchBalanceOptions = {}
  ): AsyncGenerator<BalanceUpdate, void, undefined> {
    const maxEvents = options.maxEvents ?? 1000;
    const timeoutMs = options.timeoutMs ?? 60000;
    const startTime = Date.now();
    let eventCount = 0;

    // Ensure user is initialized
    await this.getUserIndex();
    const leafIdx = this.leafIdx!;

    // Determine starting block
    let fromBlock: number;
    if (options.fromBlock === 'latest' || options.fromBlock === undefined) {
      fromBlock = await this.contract.provider.getBlockNumber();
    } else {
      fromBlock = options.fromBlock;
    }

    // Set up event filter
    const filter = this.contract.filters.LeafChange(leafIdx);

    // Query historical events if fromBlock is in the past
    const currentBlock = await this.contract.provider.getBlockNumber();
    if (fromBlock <= currentBlock) {
      const historicalEvents = await this.contract.queryFilter(filter, fromBlock, currentBlock);

      for (const event of historicalEvents) {
        // Timeout check
        if (Date.now() - startTime > timeoutMs) {
          return;
        }

        // Max events check
        if (eventCount >= maxEvents) {
          return;
        }

        const args = event.args!;
        const leaf = this.unpackLeaf(args.leaf);
        const balance = this.decryptBalance(leaf);

        const block = await event.getBlock();

        yield {
          blockNumber: event.blockNumber,
          balance,
          nonce: leaf.nonce,
          timestamp: block.timestamp,
          transactionHash: event.transactionHash
        };

        eventCount++;
      }
    }

    // Note: Async generators don't easily support event listeners
    // For now, we'll poll for new events
    const pollInterval = 2000; // 2 seconds
    let lastCheckedBlock = currentBlock;

    while (true) {
      // Timeout check
      if (Date.now() - startTime > timeoutMs) {
        break;
      }

      // Max events check
      if (eventCount >= maxEvents) {
        break;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const latestBlock = await this.contract.provider.getBlockNumber();
      if (latestBlock > lastCheckedBlock) {
        const newEvents = await this.contract.queryFilter(
          filter,
          lastCheckedBlock + 1,
          latestBlock
        );

        for (const event of newEvents) {
          // Max events check
          if (eventCount >= maxEvents) {
            return;
          }

          const args = event.args!;
          const leaf = this.unpackLeaf(args.leaf);
          const balance = this.decryptBalance(leaf);

          const block = await event.getBlock();

          yield {
            blockNumber: event.blockNumber,
            balance,
            nonce: leaf.nonce,
            timestamp: block.timestamp,
            transactionHash: event.transactionHash
          };

          eventCount++;
        }

        lastCheckedBlock = latestBlock;
      }
    }
  }
}
