# Project Context for Claude

This is a pnpm monorepo workspace for Lit Ghost - a privacy-preserving payment system with both web app and Telegram Mini App interfaces.

## Workspace Structure

```
packages/
├── app/          # Web App + Telegram Mini App (Vue 3 + Vite + TypeScript)
├── core/         # Shared cryptographic library (TypeScript + Vite)
├── lit-action/   # Lit Protocol action code (TypeScript + Vite)
└── onchain/      # Smart contracts (Hardhat + Solidity)
```

### Package: `@monorepo/app`
- **Purpose**: Dual-mode frontend application (Web App + Telegram Mini App)
- **Stack**: Vue 3, Vite, TypeScript, Vitest
- **Build**: `vue-tsc && vite build`
- **Test**: `vitest`
- **Type Check**: Use `vue-tsc --noEmit` (NOT plain `tsc`)
- **Architecture**: Single codebase that conditionally loads:
  - `WebApp.vue` for web browser access
  - `TelegramMiniApp.vue` when running in Telegram context
- **Detection**: Uses `detectTg()` in `main.ts` to determine runtime environment

### Package: `@monorepo/core`
- **Purpose**: Shared cryptographic and utility functions
- **Stack**: TypeScript, Vite (bundler), Vitest
- **Build**: Dual-mode build system
  - `pnpm build:development`: Creates both standard and sandboxed bundles
  - Standard build: `vite build` → `dist/index.js`
  - Sandboxed build: `vite build --mode sandboxed` → `dist/sandboxed.js`
  - Type declarations: `tsc --emitDeclarationOnly --declaration --outDir dist`
- **Dependencies**: `@noble/ed25519` v3, `@ethersproject/*` v5
- **Exports**: Two build modes via package.json exports:
  - `.` → `dist/index.js` (standard build with external deps)
  - `./sandboxed` → `dist/sandboxed.js` (for Lit Protocol TEE environment)

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

The project implements a privacy-preserving payment system using secp256k1 ECDH:

1. **User ID Blinding**: XOR-based blinding with ECDH shared secrets
2. **Balance Encryption**: XOR encryption with namespaced keys
3. **Leaf Structure**: Groups of 6 encrypted balances with nonces
4. **Transcript Hashing**: Deterministic hash chain for state updates

**Critical**: The TypeScript implementation in `packages/core/` must match the Solidity implementation in `packages/onchain/contracts/LitGhost.sol`. The test suite validates this compatibility.

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

# Installing packages
pnpm add <package>                    # Add dependency
pnpm add -D <package>                 # Add dev dependency
pnpm add <package> --prefer-offline   # Prefer offline cache (faster, use this when possible)

# Instead of npx, use `pnpm dlx`, e.g.
pnpm dlx shadcn-vue@latest add card button badge separator
```

## Important Notes

1. **TypeScript Module Systems**:
   - `core`: ESNext modules (`"type": "module"`)
   - `app`: ESNext modules
   - `onchain`: CommonJS (`"type": "commonjs"` for Hardhat compatibility)

2. **Workspace Dependencies**:
   - `onchain`, `app`, and `lit-action` depend on `core` via `"@monorepo/core": "workspace:*"`
   - Must build `core` before building other packages or running tests

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
   - MockToken implements ERC20 and ERC3009 (transferWithAuthorization)
   - ERC3009 support enables gasless deposits for PyUSD and USDC compatibility

## Development Workflow

1. Make changes to `core` → rebuild it → tests in `onchain` will pick up changes
2. Use `pnpm build` at root to build all packages in correct order
3. Tests validate Solidity ↔ TypeScript compatibility for crypto operations
