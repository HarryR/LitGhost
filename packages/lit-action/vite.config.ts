import { defineConfig, loadEnv } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createLitActionEnv } from './vite.shared.config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  // Load env file based on mode
  // Uses VITE_ prefix by default (only loads VITE_* vars from .env files)
  const env = loadEnv(mode, __dirname)

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: false, // Don't clear dist to keep both dev and prod builds
      minify: mode === 'production' ? 'terser' : false, // Use terser for production only
      target: 'es2020',
      ...(mode === 'production' && {
        terserOptions: {
          compress: {
            drop_console: true, // Remove console logs in production
            drop_debugger: true,
            pure_funcs: ['console.log', 'console.debug', 'console.error'],
          },
          mangle: true,
          format: {
            comments: false, // Remove all comments
          }
        }
      }),
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        name: 'LitAction',
        fileName: () => `lit-action.${mode}.js`,
        formats: ['es']
      },
      rollupOptions: {
        // Bundle everything into a single file (no external dependencies)
        // This is required for Lit Actions since they need to be self-contained
        external: [],
        output: {
          inlineDynamicImports: true,
          compact: true,
          // Embed environment variables at build time
          intro: `const ENV = ${JSON.stringify(createLitActionEnv(mode, env))};`,
        },
        // Override Vite's default plugins to ensure proper bundling
        treeshake: mode === 'production' ? 'smallest' : false,
      },
    },
    define: {
      // Make env variables available during build
      'import.meta.env.MODE': JSON.stringify(mode),
    }
  }
});
