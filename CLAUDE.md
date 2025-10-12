# Project Context for Claude

This is a pnpm monorepo workspace for a Telegram Mini App with on-chain components and cryptographic functionality.

## Workspace Structure

```
packages/
├── app/          # Telegram Mini App (Vue 3 + Vite + TypeScript)
├── core/         # Shared cryptographic library (TypeScript + Vite)
└── onchain/      # Smart contracts (Hardhat + Solidity)
```

### Package: `@monorepo/app`
- **Purpose**: Telegram Mini App frontend
- **Stack**: Vue 3, Vite, TypeScript, Vitest
- **Build**: `vue-tsc && vite build`
- **Test**: `vitest`
- **Type Check**: Use `vue-tsc --noEmit` (NOT plain `tsc`)

### Package: `@monorepo/core`
- **Purpose**: Shared cryptographic and utility functions
- **Stack**: TypeScript, Vite (bundler), Vitest
- **Build**: `vite build && tsc --emitDeclarationOnly`
- **Dependencies**: `@noble/ed25519` v3, `@noble/hashes`, `@ethersproject/*` v5
- **Important**: ed25519 v3 requires SHA-512 polyfill set in `utils.ts`:
  ```ts
  import { sha512 } from '@noble/hashes/sha2.js';
  ed25519.hashes.sha512 = sha512;
  ed25519.hashes.sha512Async = (m: Uint8Array) => Promise.resolve(sha512(m));
  ```

### Package: `@monorepo/onchain` (in `packages/onchain/`)
- **Purpose**: Solidity smart contracts and tests
- **Stack**: Hardhat, Solidity 0.8.27, TypeScript, ethers v6
- **Build**: `hardhat compile`
- **Test**: `hardhat test` (Mocha/Chai)
- **Type Check**: Skip (uses Hardhat's typechain for types)
- **Important**: Tests import from `@monorepo/core` to validate crypto compatibility

## Key Technologies

### Ethers Versions
- **Core library (`@monorepo/core`)**: Uses `@ethersproject/*` v5 packages
- **Hardhat tests (`@monorepo/onchain`)**: Uses `ethers` v6
- Both versions are compatible for the use cases in this project

### Testing
- **app**: Vitest
- **core**: Vitest (if tests are added)
- **onchain**: Hardhat test (Mocha + Chai + Hardhat matchers)

### Build Tools
- **app**: Vite
- **core**: Vite (JS bundling) + tsc (declaration files)
- **onchain**: Hardhat

## Cryptography Implementation

The project implements a privacy-preserving deposit system using ed25519 ECDH:

1. **User ID Blinding**: XOR-based blinding with ECDH shared secrets
2. **Balance Encryption**: XOR encryption with namespaced keys
3. **Leaf Structure**: Groups of 6 encrypted balances with nonces
4. **Transcript Hashing**: Deterministic hash chain for state updates

**Critical**: The TypeScript implementation in `packages/core/` must match the Solidity implementation in `packages/onchain/contracts/Dorp.sol`. The test suite validates this compatibility.

## Common Commands

```bash
# Root level
pnpm install              # Install all dependencies
pnpm build                # Build all packages
pnpm test                 # Run all tests
pnpm typecheck            # Type-check core and app packages
pnpm validate             # Full CI validation (build + test + typecheck)

# Package-specific
pnpm --filter @monorepo/core build
pnpm --filter @monorepo/app dev
pnpm --filter @monorepo/onchain test
```

## Important Notes

1. **TypeScript Module Systems**:
   - `core`: ESNext modules (`"type": "module"`)
   - `app`: ESNext modules
   - `onchain`: CommonJS (`"type": "commonjs"` for Hardhat compatibility)

2. **Workspace Dependencies**:
   - `onchain` depends on `core` via `"@monorepo/core": "workspace:*"`
   - Must build `core` before running `onchain` tests

3. **Type Declarations**:
   - `core` generates `.d.ts` files to `dist/` for consumption by other packages
   - `onchain/tsconfig.json` has `paths` mapping to resolve `@monorepo/core`

4. **CI/CD**:
   - GitHub Actions workflow in `.github/workflows/ci.yml`
   - Runs `pnpm validate` which executes build + test + typecheck
   - Type checks use appropriate tools per package (tsc vs vue-tsc)
   - Hardhat package skipped from standalone type checking (uses typechain)

5. **Hardhat Tests**:
   - Located in `packages/onchain/test/`
   - Use `computeTranscript` from `@monorepo/core` for transcript calculation
   - MockToken implements ERC20, ERC2612 (permit), and ERC3009 (transferWithAuthorization)

## Development Workflow

1. Make changes to `core` → rebuild it → tests in `onchain` will pick up changes
2. Use `pnpm build` at root to build all packages in correct order
3. Tests validate Solidity ↔ TypeScript compatibility for crypto operations
