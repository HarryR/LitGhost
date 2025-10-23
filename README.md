# 🔥👻 Lit Ghost

**Private P2P PyUSD Payments via Telegram & Web**

Made with 🤎 @ ETH Global Online 2025

[![CI](https://github.com/HarryR/LitGhost/actions/workflows/ci.yml/badge.svg)](https://github.com/HarryR/LitGhost/actions/workflows/ci.yml)
[![Deploy](https://github.com/HarryR/LitGhost/actions/workflows/deploy.yml/badge.svg)](https://github.com/HarryR/LitGhost/actions/workflows/deploy.yml)

[![Lit Protocol](https://img.shields.io/badge/Lit%20Protocol-TEE%2FPKP-blueviolet?style=flat)](https://litprotocol.com)
[![Solidity](https://img.shields.io/badge/Solidity-0.8-363636?style=flat&logo=solidity&logoColor=white)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.x-yellow?style=flat&logo=hardhat&logoColor=white)](https://hardhat.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-yellow?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Vue](https://img.shields.io/badge/Vue-3.x-green?style=flat&logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-5.x-purple?style=flat&logo=vite&logoColor=white)](https://vitejs.dev/)
[![ethers.js](https://img.shields.io/badge/ethers.js-5.x-blue?style=flat)](https://docs.ethers.org/v5/)

---

When you pay with PayPal, privacy is just... normal. The barista doesn't see your transaction history, your balance, or where else you've spent money. But PYUSD on-chain? Everything is public! Every transaction, every balance, your entire financial graph exposed forever. With Lit Ghost we're making on-chain transactions with PayPal 'normal again'.

**Telegram has 900M+ users.** No app to install, no browser plugin, no MetaMask tutorial. Just send PYUSD to `@alice` and when they open the bot, they're onboarded instantly. Gasless deposits (ERC-3009), gasless transfers, gasless withdrawals - the PKP pays all gas. Your grandmother could use this. That's the point.

**Powering this is Lit Protocol's distributed TEE network.** The system is controlled by a Programmable Key Pair (PKP) locked to immutable code on IPFS - no humans, no multisigs, no upgrade keys. User balances are encrypted on-chain in "leaves" (6 users per leaf), and every transaction updates 3 decoy leaves for privacy. The result: better anonymity than Monero (1/24 vs 1/16), trustless operation, and the UX people expect from digital payments.

## How It Works

No wallets, no seed phrases, no MetaMask popups. Just open the Telegram mini app and you're in.

- **Automatic Login**: Telegram signs your user data (`initData`) with their secret key
- **TEE Verification**: The Lit Action ([running in a TEE](packages/lit-action/src/handlers/bootstrap.ts)) verifies Telegram's signature
- **Deterministic Secrets**: Your Telegram ID derives your encryption keys - same on every device
- **Cross-Platform**: Scan a QR code to login from web or mobile - your secrets follow you

### Gasless Everything
PyUSD and USDC support ERC-3009 (`receiveWithAuthorization`), which lets the Lit Action transact on your behalf.

- **Gasless Deposits**: Sign an ERC-3009 authorization, the Lit Action submits it ([LitGhost.sol:326-357](packages/onchain/contracts/LitGhost.sol#L326-L357))
- **Gasless Internal Transfers**: Balance updates happen off-chain in encrypted leaves
- **Gasless Withdrawals**: The Lit Action signs withdrawal transactions using the PKP - you pay no gas

All gas costs are paid by the PKP (topped up by protocol fees or donations).

### Backup & Recovery
- **Export Your Secret**: Backup your LitGhost secret to recover on any device
- **No Seed Phrases**: Just login via Telegram on a new device - the Lit Action regenerates your keys deterministically
- **QR Code Login**: Scan to authenticate from web or mobile apps

## Privacy Model

### Encrypted Leaves
User balances are stored on-chain in encrypted "leaves" ([LitGhost.sol:9-13](packages/onchain/contracts/LitGhost.sol#L9-L13)):

```solidity
struct Leaf {
    bytes4[6] encryptedBalances;  // 6 users per leaf
    uint32 idx;                    // Leaf index
    uint32 nonce;                  // Increments on every update
}
```

- Each leaf holds **6 encrypted user balances**
- Encrypted with XOR masks derived from user secrets and nonce
- Only you (and the Lit Action in the TEE) can decrypt your balance

### Dummy Updates for Privacy
Every transaction updates **3 additional random leaves** as decoys:

- Your actual leaf gets updated (balance changes)
- 3 other leaves get re-encrypted (no balance change, just nonce increment)
- **Anonymity set**: 1/(6 users/leaf × 4 leaves updated) = **1/24 = 4.17%**

This means observers see 4 leaves change but can't tell which one contains the real transaction.

## Trustless Bootstrap

**The Challenge:** How do you create a system that's truly trustless? If a human controls the keys, they can rug. If a multisig controls it, they can collude. If it's upgradeable, it can be compromised.

**Our Solution:** A Programmable Key Pair (PKP) that's permanently locked to an immutable, content-addressable Lit Action on IPFS.

### How It Works

The bootstrap process ([bootstrap.ts](packages/lit-action/scripts/bootstrap.ts), [handlers/bootstrap.ts](packages/lit-action/src/handlers/bootstrap.ts)) creates a trustless system owner:

1. **Mint a PKP** - A cryptographic keypair is generated and minted as an NFT, restricted to a specific IPFS CID
   - The PKP can only be controlled by the Lit Action at that exact IPFS hash
   - No other code can ever use this key to sign transactions

2. **Generate Entropy in TEE** - The Lit Action executes inside a Trusted Execution Environment and generates cryptographic entropy
   - This entropy seeds all user secrets and encryption keys
   - It's encrypted using Lit Protocol's access control (only decryptable by this exact IPFS CID)

3. **Sign with the PKP** - The Lit Action signs the entropy data using the PKP's private key ([bootstrap.ts:25-29](packages/lit-action/src/handlers/bootstrap.ts#L25-L29))
   ```typescript
   const signature = ctx.litEcdsaSigToEthSig(await Lit.Actions.signAndCombineEcdsa({
     toSign,
     publicKey: request.pkpPublicKey,
     sigName: 'bootstrap-sig',
   }));
   ```
   - The signature proves: "This entropy was generated by the code at IPFS CID X, controlling PKP Y"
   - Only that specific Lit Action code can produce this signature

4. **Lock the Contract** - The Lit Action calls `setEntropy()` on [LitGhost.sol](packages/onchain/contracts/LitGhost.sol#L107-L132)
   - The contract verifies the signature matches the PKP's address ([LitGhost.sol:120-127](packages/onchain/contracts/LitGhost.sol#L120-L127))
   - This proves the caller possesses the PKP's private key
   - The function can only be called once ([LitGhost.sol:111](packages/onchain/contracts/LitGhost.sol#L111))
   - The PKP becomes the permanent contract owner ([LitGhost.sol:131](packages/onchain/contracts/LitGhost.sol#L131))

5. **Immutable Forever** - The result is a contract controlled by a PKP, which is controlled by code at a specific IPFS CID
   - IPFS CIDs are content-addressable: the hash uniquely identifies the exact bytes
   - The code cannot be changed without changing the hash
   - The PKP cannot execute different code
   - No upgrade paths, no backdoors, no rug vectors

### Why This Matters

**Content-Addressable**: The IPFS CID is a cryptographic hash of the Lit Action code. Change one byte, the hash changes, and the PKP won't execute it.

**Cryptographically Provable**: The signature in `setEntropy()` proves that only the specific Lit Action code at the IPFS CID could have generated and signed the entropy. Anyone can verify this on-chain.

**Immutable**: Once `setEntropy()` is called, the contract owner is locked forever. No admin functions, no upgrades, no takeover possible.

**Trustless**: The PKP's private key never exists in plain text. It's managed by Lit Protocol's distributed network of TEE nodes. No single party can access it.

**Transparent**: Anyone can:
  - Read the Lit Action source code
  - Compute the IPFS CID themselves
  - Verify the PKP is restricted to exactly that CID
  - Confirm the entropy signature matches
  - Trust the system without trusting any person

This is what true decentralization looks like: a system where the "admin" is not a person or company, but an immutable, auditable program running in a distributed TEE network.
