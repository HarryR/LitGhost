import { defineConfig } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const isSandboxed = mode === 'sandboxed'

  return {
    resolve: isSandboxed ? {
      alias: {
        // For sandboxed build, replace ethers-compat with sandboxed version
        './ethers-compat.js': resolve(__dirname, 'src/ethers-compat.sandboxed.ts')
      }
    } : undefined,
    build: {
      outDir: 'dist',
      emptyOutDir: !isSandboxed, // Only empty on first build (standard)
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        name: 'Core',
        fileName: () => isSandboxed ? 'sandboxed.js' : 'index.js',
        formats: ['es']
      },
      rollupOptions: {
        // Standard build: keep @ethersproject external for tree-shaking
        // Sandboxed build: keep everything external (uses globals)
        external: [
          '@ethersproject/abi',
          '@ethersproject/bytes',
          '@ethersproject/keccak256',
          '@ethersproject/random',
          '@ethersproject/signing-key',
          '@ethersproject/contracts',
        ],
        output: {
          inlineDynamicImports: true
        }
      }
    }
  }
});
