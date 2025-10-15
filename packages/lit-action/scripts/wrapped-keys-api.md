# Lit Protocol Wrapped Keys API

This document describes the Lit Protocol Wrapped Keys service API for storing and retrieving encrypted private keys.

## Overview

The Wrapped Keys service provides centralized storage for encrypted private keys that can only be decrypted by authorized Lit Actions using PKPs. This enables deterministic key derivation by storing a single generated key rather than relying on signing operations.

## Service URLs

```typescript
const SERVICE_URLS = {
  TestNetworks: 'https://test.wrapped.litprotocol.com/encrypted',
  Production: 'https://wrapped.litprotocol.com/encrypted'
};

// Network mapping
const NETWORK_TYPE = {
  DatilDev: 'TestNetworks',
  DatilTest: 'TestNetworks',
  Datil: 'Production'
};
```

## Authentication

All requests require a session signature for authorization:

```typescript
// Authorization header format
const authHeader = 'LitSessionSig:' + btoa(JSON.stringify(sessionSig));

// Headers
{
  'Content-Type': 'application/json',
  'Authorization': authHeader,
  'X-Request-Id': generateRequestId() // Random UUID
}
```

## API Endpoints

### 1. Store Private Key

**POST** `/`

Stores encrypted private key metadata for a PKP.

**Request Body:**
```typescript
{
  sessionSig: string;           // Session signature
  storedKeyMetadata: {
    pkpAddress: string;         // PKP Ethereum address
    id: string;                 // Unique key identifier
    ciphertext: string;         // Encrypted key data
    dataToEncryptHash: string;  // Hash of original data
    publicKey: string;          // Public key (optional)
    keyType: string;            // e.g., 'K256', 'ed25519'
    memo: string;               // Description (optional)
  }
}
```

**Response:**
```typescript
{
  id: string;        // Key identifier
  pkpAddress: string;
}
```

### 2. Store Private Key Batch

**POST** `/_batch`

Stores up to 25 keys in a single request.

**Request Body:**
```typescript
{
  sessionSig: string;
  storedKeyMetadata: Array<{
    pkpAddress: string;
    id: string;
    ciphertext: string;
    dataToEncryptHash: string;
    publicKey?: string;
    keyType: string;
    memo?: string;
  }>
}
```

**Response:**
```typescript
{
  successes: Array<{ id: string; pkpAddress: string; }>;
  errors: Array<{ error: string; }>;
}
```

### 3. List Private Keys (Metadata Only)

**GET** `/{pkpAddress}`

Returns metadata for all keys associated with a PKP (without decryption details).

**Response:**
```typescript
Array<{
  pkpAddress: string;
  id: string;
  publicKey?: string;
  keyType: string;
  memo?: string;
}>
```

### 4. Fetch Private Key

**GET** `/{pkpAddress}/{id}`

Returns complete key data including decryption details.

**Response:**
```typescript
{
  pkpAddress: string;
  id: string;
  ciphertext: string;
  dataToEncryptHash: string;
  publicKey?: string;
  keyType: string;
  memo?: string;
}
```

## Usage Pattern

### Generate and Store Key (Run Once)

```typescript
// In Lit Action - runs once to generate key
const result = await Lit.Actions.runOnce(
  { waitForResponse: true, name: 'generateKey' },
  async () => {
    // 1. Generate random private key
    const privateKey = ethers.Wallet.createRandom().privateKey;

    // 2. Add "salt" prefix (their terminology, not actually a salt)
    const keyWithPrefix = 'lit_' + privateKey.slice(2);

    // 3. Encrypt the key
    const { ciphertext, dataToEncryptHash } = await Lit.Actions.encrypt({
      accessControlConditions,
      to_encrypt: ethers.utils.toUtf8Bytes(keyWithPrefix)
    });

    // 4. Get public key
    const wallet = new ethers.Wallet(privateKey);
    const publicKey = wallet.address;

    return JSON.stringify({
      ciphertext,
      dataToEncryptHash,
      publicKey
    });
  }
);

const encryptedKey = JSON.parse(result);

// 5. Store to wrapped keys service (client-side or via fetch in Lit Action)
await fetch(`${serviceUrl}/`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'LitSessionSig:' + btoa(JSON.stringify(sessionSig))
  },
  body: JSON.stringify({
    sessionSig,
    storedKeyMetadata: {
      pkpAddress: pkpEthAddress,
      id: 'my-key-id',
      ciphertext: encryptedKey.ciphertext,
      dataToEncryptHash: encryptedKey.dataToEncryptHash,
      publicKey: encryptedKey.publicKey,
      keyType: 'K256',
      memo: 'My deterministic key'
    }
  })
});
```

### Retrieve and Decrypt Key (Subsequent Runs)

```typescript
// In Lit Action - fetch and decrypt stored key
const keyId = 'my-key-id';

// 1. Fetch encrypted key from service
const response = await fetch(
  `${serviceUrl}/${pkpAddress}/${keyId}`,
  {
    headers: {
      'Authorization': 'LitSessionSig:' + btoa(JSON.stringify(sessionSig))
    }
  }
);

const storedKey = await response.json();

// 2. Decrypt to single node (only one node gets plaintext)
const decryptedKey = await Lit.Actions.decryptToSingleNode({
  accessControlConditions,
  ciphertext: storedKey.ciphertext,
  dataToEncryptHash: storedKey.dataToEncryptHash,
  authSig: null,
  chain: 'ethereum'
});

// 3. Remove the "salt" prefix
const LIT_PREFIX = 'lit_';
if (!decryptedKey.startsWith(LIT_PREFIX)) {
  throw new Error('Key was not encrypted with expected prefix');
}
const privateKey = '0x' + decryptedKey.slice(LIT_PREFIX.length);

// 4. Use the private key
const wallet = new ethers.Wallet(privateKey);
// Now you have a deterministic wallet!
```

## Key Properties

### `storedKeyMetadata` Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pkpAddress` | string | Yes | PKP's Ethereum address (owner) |
| `id` | string | Yes | Unique identifier for this key |
| `ciphertext` | string | Yes | Encrypted private key data |
| `dataToEncryptHash` | string | Yes | Hash used for decryption |
| `publicKey` | string | No | Public key or address |
| `keyType` | string | Yes | Curve type: 'K256', 'ed25519', etc |
| `memo` | string | No | Human-readable description |

### Key Types

- `K256` - secp256k1 (Ethereum, Bitcoin)
- `ed25519` - EdDSA (Solana, etc)
- Custom - Any other cryptographic curve

## Security Notes

1. **Centralized Storage**: Keys are stored on Lit Protocol's servers, encrypted
2. **TEE/DKG Protection**: Decryption only happens within Lit's TEE using threshold decryption
3. **Access Control**: Only authorized PKPs with proper session signatures can access
4. **Single Node Decryption**: `decryptToSingleNode` ensures only one node sees plaintext
5. **No Network Visibility**: Other nodes never see the decrypted key

## Example: Complete Workflow

### Step 1: Initial Setup (Generate & Store)

```typescript
// Execute Lit Action that generates and stores key
const result = await litNodeClient.executeJs({
  code: generateKeyLitAction,
  sessionSigs,
  jsParams: {
    pkpAddress: myPkpAddress,
    keyId: 'my-deterministic-key',
    accessControlConditions: [
      {
        contractAddress: '',
        standardContractType: '',
        chain: 'ethereum',
        method: '',
        parameters: [':userAddress'],
        returnValueTest: {
          comparator: '=',
          value: myPkpAddress
        }
      }
    ]
  }
});

// Returns the public address you can use
const { publicKey } = JSON.parse(result.response);
console.log('Derived address:', publicKey);
```

### Step 2: Future Use (Fetch & Decrypt)

```typescript
// Execute Lit Action that fetches and uses stored key
const result = await litNodeClient.executeJs({
  code: useKeyLitAction,
  sessionSigs,
  jsParams: {
    pkpAddress: myPkpAddress,
    keyId: 'my-deterministic-key',
    dataToSign: messageHash
  }
});

// Returns signature made with the deterministic key
const { signature } = JSON.parse(result.response);
```

## Deployment Strategy

For your use case (provably inaccessible contract owner):

1. **CI/Deployment Phase:**
   - Mint PKP
   - Execute Lit Action to generate wrapped key (runs once)
   - Store encrypted key in Lit's service
   - Get derived Ethereum address
   - Deploy contract with yourself as owner
   - Transfer ownership to derived address
   - Upload Lit Action to IPFS (get CID)
   - Lock PKP permissions to only that IPFS CID
   - Delete any local keys

2. **Result:**
   - Contract is owned by an address only the Lit Action can sign for
   - Lit Action is immutable (IPFS)
   - PKP is locked to that specific Lit Action
   - You provably cannot access the private key
   - Fully auditable and trustless

## Testing Considerations

The `@lit-protocol/wrapped-keys` package needs bundling for Lit Actions. For testing:

1. **Option A**: Set up esbuild/vite bundling in experiments
2. **Option B**: Use raw `fetch` calls as shown above (no SDK needed)
3. **Option C**: Test flow conceptually, implement properly in deployment scripts

For the experiments, option B (raw fetch) is simplest since we just need to understand the API.

## References

- Service Client: `packages/wrapped-keys/src/lib/service-client/client.ts`
- Constants: `packages/wrapped-keys/src/lib/service-client/constants.ts`
- Types: `packages/wrapped-keys/src/lib/service-client/types.ts`
- Utils: `packages/wrapped-keys/src/lib/service-client/utils.ts`
- Docs: https://developer.litprotocol.com/user-wallets/wrapped-keys/custom-wrapped-keys
