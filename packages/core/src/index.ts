// Crypto utilities
export {
  type DepositTo,
  type Leaf,
  blindUserId,
  unblindUserId,
  createDepositTo,
  decryptDepositTo,
  encryptBalance,
  decryptBalance,
  encryptLeaf,
  decryptLeafBalance,
  getUserLeafInfo,
  isValidTelegramUsername,
  NAMESPACE_BALANCE,
  NAMESPACE_DEPOSIT
} from './crypto';

// Transcript utilities
export {
  type Payout,
  type UpdateBatch,
  computeTranscript,
  createEmptyLeaf
} from './transcript';

// Utility functions
export {
  encodeUint32,
  encodeUint256,
  decodeUint32,
  xorBytes,
  createNamespacedKey,
  computeSharedSecret,
  randomKeypair,
  deriveUserKeypair,
  reconstructCompressedPublicKey,
  namespacedHmac,
} from './utils';

export {
  LitGhost,
  Token
} from './contracts';

// Ethers compatibility layer
export {
  JsonRpcProvider,
  Contract,
  keccak256,
  arrayify,
  concat,
  hexlify,
  toUtf8Bytes,
  randomBytes
} from './ethers-compat';

// Manager utilities
export {
  ManagerContext,
  type DepositEvent,
  type InternalTransaction
} from './manager';

// User client
export {
  UserClient,
  type BalanceUpdate,
  type WatchBalanceOptions
} from './user';
