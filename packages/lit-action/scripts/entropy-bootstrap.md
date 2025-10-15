# Entropy Bootstrap Pattern for Lit Actions

This document describes the pattern for bootstrapping a Lit Action with deterministic, verifiable entropy without relying on external key storage services.

## The Bootstrap Problem

When deploying a Lit Action that needs a deterministic private key:

1. Need to encrypt entropy with policy: "only this IPFS CID can decrypt"
2. Need to embed encrypted entropy in contract
3. Need IPFS CID of the code... which needs the contract address

Classic circular dependency.

## Solution: On-Chain Storage

Store encrypted entropy on-chain, separating deployment phases:

```
Deploy contract (uninitialized)
  ↓
Upload Lit Action to IPFS (with hardcoded contract address)
  ↓
Get IPFS CID
  ↓
Execute Lit Action to generate & encrypt entropy
  ↓
Initialize contract with encrypted data + derived wallet
```

## Contract Interface

```solidity
contract LitActionContract {
    bytes public encryptedEntropy;
    bytes32 public dataToEncryptHash;
    address public litActionWallet;
    bool public initialized;

    function initialize(
        bytes calldata _encryptedEntropy,
        bytes32 _dataToEncryptHash,
        address _litActionWallet
    ) external {
        require(!initialized, "Already initialized");
        require(_litActionWallet != address(0), "Invalid wallet");

        encryptedEntropy = _encryptedEntropy;
        dataToEncryptHash = _dataToEncryptHash;
        litActionWallet = _litActionWallet;
        initialized = true;

        // Transfer ownership to the derived wallet
        transferOwnership(_litActionWallet);
    }

    function getEncryptedData() external view returns (bytes memory, bytes32) {
        require(initialized, "Not initialized");
        return (encryptedEntropy, dataToEncryptHash);
    }
}
```

## Lit Action: Initialize Handler

```typescript
if (action === 'initialize') {
  // 1. Check contract not already initialized
  const isInitialized = await Lit.Actions.call({
    chain: 'ethereum',
    address: CONTRACT_ADDRESS,
    abi: [...],
    method: 'initialized',
    params: []
  });

  if (isInitialized) {
    throw new Error('Contract already initialized');
  }

  // 2. Generate random entropy
  const entropy = ethers.utils.randomBytes(32);

  // 3. Encrypt with access control: only this IPFS CID can decrypt
  const { ciphertext, dataToEncryptHash } = await Lit.Actions.encrypt({
    accessControlConditions: [
      {
        method: '',
        params: [':litActionIpfsId'],
        returnValueTest: {
          comparator: '=',
          value: ipfsCid  // The IPFS CID of this Lit Action
        }
      }
    ],
    to_encrypt: entropy
  });

  // 4. Derive Ethereum wallet from entropy
  const wallet = new ethers.Wallet(entropy);

  // 5. Return data for contract initialization
  Lit.Actions.setResponse({
    response: JSON.stringify({
      ciphertext: ethers.utils.hexlify(ciphertext),
      dataToEncryptHash: ethers.utils.hexlify(dataToEncryptHash),
      walletAddress: wallet.address
    })
  });
}
```

## Lit Action: Execute Handler

```typescript
if (action === 'execute') {
  // 1. Load encrypted data from contract
  const [encryptedEntropy, dataHash] = await Lit.Actions.call({
    chain: 'ethereum',
    address: CONTRACT_ADDRESS,
    abi: [...],
    method: 'getEncryptedData',
    params: []
  });

  // 2. Decrypt entropy (only this IPFS CID can decrypt!)
  const decryptedEntropy = await Lit.Actions.decryptToSingleNode({
    accessControlConditions: [
      {
        method: '',
        params: [':litActionIpfsId'],
        returnValueTest: {
          comparator: '=',
          value: ipfsCid
        }
      }
    ],
    ciphertext: encryptedEntropy,
    dataToEncryptHash: dataHash,
    chain: 'ethereum',
    authSig: null
  });

  // 3. Re-derive wallet from entropy
  const entropyBytes = ethers.utils.arrayify(decryptedEntropy);
  const wallet = new ethers.Wallet(entropyBytes);

  // 4. Use wallet for signing operations
  const signature = await wallet.signMessage(message);

  Lit.Actions.setResponse({
    response: JSON.stringify({ signature })
  });
}
```

## Access Control Conditions

The critical security property is the access control condition:

```typescript
const accessControlConditions = [
  {
    method: '',              // Empty for IPFS CID check
    params: [':litActionIpfsId'],  // Special parameter for current action's CID
    returnValueTest: {
      comparator: '=',
      value: 'QmYourIPFSCID'  // The specific IPFS CID
    }
  }
];
```

This ensures **only code with this exact IPFS CID** can decrypt the entropy.

## Deployment Flow

### Step 1: Deploy Uninitialized Contract

```typescript
const contract = await deploy('LitActionContract');
console.log('Contract deployed:', contract.address);
// Contract is deployed but not initialized
```

### Step 2: Upload Lit Action to IPFS

```typescript
const litActionCode = `
const CONTRACT_ADDRESS = '${contract.address}';
const ipfsCid = 'QmWillBeReplacedWithActualCID';

(async () => {
  const action = Lit.Actions.getParam('action');

  if (action === 'initialize') {
    // ... initialize handler code ...
  }

  if (action === 'execute') {
    // ... execute handler code ...
  }
})();
`;

const ipfsCid = await uploadToIPFS(litActionCode);
console.log('IPFS CID:', ipfsCid);
```

### Step 3: Execute Initialize

```typescript
const result = await litNodeClient.executeJs({
  ipfsId: ipfsCid,
  sessionSigs,
  jsParams: {
    action: 'initialize'
  }
});

const { ciphertext, dataToEncryptHash, walletAddress } = JSON.parse(result.response);
console.log('Derived wallet address:', walletAddress);
```

### Step 4: Initialize Contract

```typescript
await contract.initialize(
  ciphertext,
  dataToEncryptHash,
  walletAddress
);
console.log('Contract initialized');
console.log('Ownership transferred to:', walletAddress);
```

### Step 5: Lock PKP Permissions (Optional)

```typescript
// Lock the PKP to only execute this specific IPFS CID
await pkpPermissionsContract.addPermittedAction(
  pkpTokenId,
  ipfsCid,
  [] // No additional scopes needed
);
```

## Security Properties

### What's Guaranteed

1. **Content-addressable encryption**: Only the specific IPFS CID can decrypt
2. **Verifiable policy**: Anyone can verify the encryption policy on-chain
3. **Immutable**: Any code change = different CID = can't decrypt old entropy
4. **No secrets in code**: The ciphertext is public, the policy enforces access
5. **On-chain storage**: No reliance on external key storage services
6. **Idempotent initialization**: Can only be initialized once

### Trust Assumptions

1. Lit Protocol's TEE/DKG implementation
2. IPFS content addressing (CID collision resistance)
3. Ethereum consensus for storing encrypted data
4. Your contract's initialization logic

### What You Can Prove

1. You cannot decrypt the entropy (don't have the right IPFS CID)
2. Only that specific code can decrypt (policy is verifiable)
3. The code is immutable (IPFS)
4. The derived wallet was generated by that code (on-chain record)

## Derivation Patterns

From the base entropy, derive multiple secrets:

```typescript
const entropy = decryptedEntropy;

// Derive Ethereum wallet
const wallet = new ethers.Wallet(entropy);

// Derive additional secrets with domain separation
const secret1 = ethers.utils.keccak256(
  ethers.utils.concat([
    entropy,
    ethers.utils.toUtf8Bytes('DOMAIN_1')
  ])
);

const secret2 = ethers.utils.keccak256(
  ethers.utils.concat([
    entropy,
    ethers.utils.toUtf8Bytes('DOMAIN_2')
  ])
);

// Derive other curve keys if needed
const ed25519Seed = ethers.utils.keccak256(
  ethers.utils.concat([
    entropy,
    ethers.utils.toUtf8Bytes('ED25519')
  ])
);
```

## Error Handling

```typescript
// In Lit Action
try {
  const [ciphertext, dataHash] = await Lit.Actions.call({
    chain: 'ethereum',
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    method: 'getEncryptedData',
    params: []
  });

  if (ciphertext === '0x' || ciphertext.length === 0) {
    throw new Error('Contract not initialized');
  }

  const decrypted = await Lit.Actions.decryptToSingleNode({
    accessControlConditions,
    ciphertext,
    dataToEncryptHash: dataHash,
    chain: 'ethereum',
    authSig: null
  });

  if (!decrypted) {
    throw new Error('Decryption failed - wrong IPFS CID?');
  }

  // Continue with decrypted entropy...

} catch (error) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: error.message,
      stack: error.stack
    })
  });
}
```

## Comparison with Wrapped Keys

| Wrapped Keys Service | On-Chain Bootstrap |
|---------------------|-------------------|
| Centralized storage at wrapped.litprotocol.com | On-chain storage |
| Session sig based access control | IPFS CID based access control |
| Requires SDK bundling | Native Lit Actions API |
| "Salt" prefix for identification | Proper access control conditions |
| External service dependency | Only depends on blockchain |
| Not verifiable on-chain | Fully auditable on-chain |

## Testing Considerations

For local testing:
1. Deploy contract to testnet (e.g., Sepolia)
2. Upload Lit Action to IPFS or use inline code during development
3. Use datil-dev network for Lit Protocol
4. Test initialize → execute flow
5. Verify contract state after initialization

For production:
1. Deploy to mainnet
2. Upload final Lit Action to IPFS
3. Use production Lit network
4. Lock PKP permissions to IPFS CID
5. Transfer any remaining admin permissions away (burn them)

## Gotchas

1. **IPFS CID must be exact**: Any whitespace or comment change invalidates the CID
2. **Contract address must be correct**: Hardcoded in Lit Action, can't change later
3. **Initialization is permanent**: Can't re-initialize or rotate entropy
4. **dataToEncryptHash is public**: Don't encrypt low-entropy secrets (use 256-bit random)
5. **decryptToSingleNode**: Only one node gets plaintext, but still be cautious with logging

## Future Improvements

Potential enhancements to consider:

1. **Multi-sig initialization**: Require multiple parties to approve before initialization
2. **Entropy rotation**: Allow rotating entropy with proper access controls
3. **Backup mechanisms**: Store encrypted backup with different policy
4. **Versioning**: Support multiple IPFS CIDs with migration path
5. **Emergency recovery**: Time-locked backup access for emergencies
