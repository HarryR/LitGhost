import type {
  GhostRequest,
  GhostResponseDataMap,
} from '@monorepo/lit-action/params';

/**
 * Custom error type for Ghost client failures
 */
export class GhostClientError extends Error {
  constructor(
    message: string,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'GhostClientError';
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GhostClientError);
    }
  }
}

/**
 * Interface for GhostClient - allows for type-safe usage without loading heavy Lit Protocol dependencies
 */
export interface IGhostClient {
  connect(): Promise<void>;
  call<T extends GhostRequest>(request: T): Promise<GhostResponseDataMap[T['type']]>;

  // Strongly-typed convenience methods
  echo(message: string): Promise<GhostResponseDataMap['echo']>;
  bootstrap(pkpPublicKey: string, pkpEthAddress: string, tgApiSecret: string): Promise<GhostResponseDataMap['bootstrap']>;
  registerTelegram(initDataRaw: string): Promise<GhostResponseDataMap['register-telegram']>;
  submitDeposit(params: {
    depositTo: {
      rand: string;
      user: string;
    };
    auth3009: {
      from: string;
      value: string;
      validAfter: number;
      validBefore: number;
      sig: {
        v: number;
        r: string;
        s: string;
      };
    };
  }): Promise<GhostResponseDataMap['submit-deposit']>;
}
