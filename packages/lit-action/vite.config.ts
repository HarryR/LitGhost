import { defineConfig, loadEnv, type Plugin } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createLitActionEnv } from './vite.shared.config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Plugin to strip all comments from the final bundle except sourceMappingURL
function stripCommentsPlugin(): Plugin {
  return {
    name: 'strip-comments',
    generateBundle(_options, bundle) {
      for (const fileName in bundle) {
        const chunk = bundle[fileName]
        if (chunk.type === 'chunk' && chunk.code) {
          // Remove all comments except sourceMappingURL
          chunk.code = chunk.code
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove /* */ comments
            .replace(/\/\/(?!#\s*sourceMappingURL=).*/g, '') // Remove // comments except sourceMappingURL
            .replace(/^\s*[\r\n]/gm, '') // Remove empty lines
        }
      }
    }
  }
}

export default defineConfig(({ mode }) => {
  // Load env file based on mode
  // Uses VITE_ prefix by default (only loads VITE_* vars from .env files)
  const env = loadEnv(mode, __dirname)

  return {
    plugins: [stripCommentsPlugin()],
    build: {
      outDir: 'dist',
      emptyOutDir: false, // Don't clear dist to keep both dev and prod builds
      minify: 'esbuild', // Use esbuild for faster, more aggressive minification
      target: 'es2020',
      sourcemap: true, // Generate sourcemaps for debugging
      // Configure esbuild for maximum minification
      esbuild: {
        legalComments: 'none', // Remove all legal comments
        minifyIdentifiers: true,
        minifySyntax: true,
        minifyWhitespace: true,
        treeShaking: true,
      },
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
        treeshake: 'smallest',
      },
    },
    define: {
      // Make env variables available during build
      'import.meta.env.VITE_MODE': JSON.stringify(mode),
    }
  }
});
