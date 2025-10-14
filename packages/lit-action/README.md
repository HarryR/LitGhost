# @monorepo/lit-action

A Lit Action package that compiles TypeScript into a single, minified JavaScript file for deployment on the Lit Protocol network, with a local testing server for rapid development.

## Overview

Lit Actions are JavaScript programs that run inside a Trusted Execution Environment (TEE) on the Lit Protocol network using Deno. This package:

- **Type-safe request handling** via discriminated union (`GhostRequest`)
- **Local testing server** with instant HMR (Hot Module Replacement)
- **Isolated execution contexts** that simulate Lit's disposable process model
- **Lit SDK mocking** for testing signing operations locally
- Uses `@monorepo/core` for shared cryptographic functionality
- Compiles TypeScript to a single minified JavaScript file
- Supports environment-based builds (development/production)
- Embeds environment variables at build time
- Optimizes for minimal file size (for IPFS storage)

## Quick Start

**Local Development (Recommended):**
```bash
# Start the local test server with HMR
pnpm --filter @monorepo/lit-action dev:server

# In another terminal, test with curl
curl -X POST http://localhost:3030/lit-test \
  -H "Content-Type: application/json" \
  -d '{"ghostRequest": {"type": "echo", "message": "Hello!"}, "publicKey": "0x1234"}'
```

Changes to your code are reflected instantly on the next request - no restarts needed!

See [TEST_EXAMPLES.md](./TEST_EXAMPLES.md) for more examples.

## Setup

1. Copy `.env.example` to create your environment files:
   ```bash
   cp .env.example .env.development
   cp .env.example .env.production
   ```

2. Configure your environment variables in the respective files

3. Install dependencies (from workspace root):
   ```bash
   pnpm install
   ```

## Building

Build for development:
```bash
pnpm build:dev
# or
pnpm --filter @monorepo/lit-action build:dev
```

Build for production:
```bash
pnpm build
# or
pnpm --filter @monorepo/lit-action build:prod
```

Watch mode (rebuilds on file changes):
```bash
pnpm dev
```

## Output

The build process creates a single minified JavaScript file:
- `dist/lit-action.development.js` - Development build (with console logs)
- `dist/lit-action.production.js` - Production build (console logs removed, maximum minification)

This file is self-contained and ready to be uploaded to IPFS for use with Lit Protocol.

## Environment Variables

Environment variables are embedded into the build at compile time via the `ENV` global object. Configure them in:

- `.env.development` - Used when building with `--mode development`
- `.env.production` - Used when building with `--mode production`

Example usage in code:
```typescript
declare const ENV: {
  MODE: string;
  TELEGRAM_BOT_API_KEY: string;
};

const apiKey = ENV.TELEGRAM_BOT_API_KEY;
```

**Security Note**: Since these values are embedded in the JavaScript file at build time, ensure sensitive values are encrypted before building, or handle decryption within the Lit Action using PKP keys.

## Adding New Environment Variables

1. Add the variable to `.env.example`, `.env.development`, and `.env.production`
2. Update `vite.config.ts` to include it in the `ENV` object
3. Update the type declaration in `src/index.ts`

### Request Flow

1. **Client** sends `jsParams` to Lit Protocol (or test server)
   ```typescript
   {
     ghostRequest: { type: 'echo', message: 'Hello' }
   }
   ```

2. **Lit Action Runtime** (or test server) injects jsParams as globals

3. **main()** function validates jsParams and calls `handleRequest()`

4. **handleRequest()** pattern matches on `ghostRequest.type` and executes appropriate logic

5. **Response** is set via `Lit.Actions.setResponse()` and returned to client
