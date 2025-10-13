import { arrayify, Contract } from './ethers-compat.js';
import {
  getUserLeafInfo,
  decryptLeafBalance,
  type Leaf
} from './crypto';
import {
  computeSharedSecret,
  decodeUint32
} from './utils';

/**
 * Represents a balance update event
 */
export interface BalanceUpdate {
  blockNumber: number;
  balance: number;
  nonce: number;
  transactionHash: string;
}

/**
 * Options for watching balance updates
 */
export interface WatchBalanceOptions {
  /** Maximum number of events to process before stopping (default: Infinity - run forever) */
  maxEvents?: number;
  /** Starting block number (default: current block) */
  fromBlock?: number | 'latest';
  /** Emit keepalive null signals every N milliseconds when no events occur (default: disabled) */
  keepaliveMs?: number;
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
    this.userIndex = Number(firstIndex);

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
    const idx = decodeUint32(bytes.slice(24, 28));

    // Last 4 bytes: nonce (uint32)
    const nonce = decodeUint32(bytes.slice(28, 32));

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
    // Ensure user index and leaf info are cached
    await this.getUserIndex();

    const leafIdx = this.leafIdx!;
    const leaves = await this.contract.getLeaves([leafIdx]);
    const leaf: Leaf = {
      encryptedBalances: leaves[0].encryptedBalances.map((b: string) => arrayify(b)),
      idx: Number(leaves[0].idx),
      nonce: Number(leaves[0].nonce)
    };

    return this.decryptBalance(leaf);
  }

  /**
   * Process a LeafChange event and create a BalanceUpdate
   * Returns null if the event should be filtered (nonce already seen)
   */
  private processLeafChangeEvent(
    event: any,
    lastSeenNonce: number
  ): BalanceUpdate | null {
    const args = event.args!;
    const leaf = this.unpackLeaf(args.leaf);

    // Nonce-based filtering: ignore events with nonces we've already seen
    if (leaf.nonce <= lastSeenNonce) {
      return null;
    }

    const balance = this.decryptBalance(leaf);

    return {
      blockNumber: event.blockNumber,
      balance,
      nonce: leaf.nonce,
      transactionHash: event.transactionHash
    };
  }

  /**
   * Watch for balance updates via LeafChange events
   * Returns an async generator that yields balance updates
   *
   * Uses websocket event listeners for real-time updates.
   * Events are filtered by nonce to handle out-of-order delivery and prevent duplicates.
   * Only events with nonces greater than previously seen nonces are yielded.
   *
   * Runs indefinitely by default. User can stop by breaking out of the for-await loop.
   * The cleanup (removing event listeners) happens automatically when the loop exits.
   *
   * @example
   * ```typescript
   * // Run forever with keepalive signals
   * for await (const update of client.watchBalanceUpdates({ keepaliveMs: 30000 })) {
   *   if (update === null) {
   *     console.log('Still alive, no events in last 30 seconds');
   *     if (shouldStop()) break;
   *   } else {
   *     console.log(`Balance: ${update.balance}, Nonce: ${update.nonce}`);
   *   }
   * }
   *
   * // Or limit to 10 events
   * for await (const update of client.watchBalanceUpdates({ maxEvents: 10 })) {
   *   console.log(`Balance: ${update.balance}, Nonce: ${update.nonce}`);
   * }
   * ```
   */
  async *watchBalanceUpdates(
    options: WatchBalanceOptions = {}
  ): AsyncGenerator<BalanceUpdate | null, void, undefined> {
    const maxEvents = options.maxEvents ?? Infinity;
    const keepaliveMs = options.keepaliveMs;
    let eventCount = 0;
    let lastSeenNonce = -1;

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
        // Max events check
        if (eventCount >= maxEvents) {
          return;
        }

        const update = this.processLeafChangeEvent(event, lastSeenNonce);
        if (!update) {
          continue;
        }

        yield update;
        lastSeenNonce = update.nonce;
        eventCount++;
      }
    }

    // Check if provider supports websockets (has 'on' method)
    const supportsWebsockets = typeof (this.contract.provider as any).on === 'function';

    if (!supportsWebsockets) {
      throw new Error('Provider does not support websockets. Please use a websocket provider (e.g., wss://...)');
    }

    // Use event listeners for real-time updates (websocket)
    const eventQueue: BalanceUpdate[] = [];
    let resolveNext: ((value: BalanceUpdate) => void) | null = null;
    let finished = false;

    const eventHandler = (_idx: number, _leaf: string, event: any) => {
      if (finished) return;

      try {
        const update = this.processLeafChangeEvent(event, lastSeenNonce);
        if (!update) {
          return;
        }

        if (resolveNext) {
          resolveNext(update);
          resolveNext = null;
        } else {
          eventQueue.push(update);
        }
      } catch (err) {
        // Ignore errors in event processing
      }
    };

    // Register event listener for new events
    this.contract.on(filter, eventHandler);

    try {
      while (true) {
        // Max events check
        if (eventCount >= maxEvents) {
          break;
        }

        // Get next event from queue or wait for one
        let update: BalanceUpdate | null;
        if (eventQueue.length > 0) {
          update = eventQueue.shift()!;
        } else {
          // Wait for next event with timeout
          // Use keepaliveMs if specified, otherwise default to 5 seconds for periodic checking
          const waitTimeout = keepaliveMs ?? 5000;

          update = await new Promise<BalanceUpdate>((resolve, reject) => {
            resolveNext = resolve;
            setTimeout(() => reject(new Error('timeout')), waitTimeout);
          }).catch(() => null as any);

          if (!update) {
            resolveNext = null;

            // If keepalive is enabled, emit a null signal
            if (keepaliveMs !== undefined) {
              yield null;
            }

            continue; // No event received, loop back to check maxEvents and try again
          }
        }

        lastSeenNonce = update.nonce;
        yield update;
        eventCount++;
      }
    } finally {
      // Cleanup: remove event listener when generator is stopped
      // This runs whether the user breaks, an error occurs, or maxEvents is reached
      finished = true;
      this.contract.off(filter, eventHandler);
    }
  }
}
