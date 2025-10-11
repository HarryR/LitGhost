import { defineConfig } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(dirname(fileURLToPath(import.meta.url)), 'src/index.ts'),
      name: 'Core',
      fileName: () => 'index.js',
      formats: ['es']
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      }
    }
  }
})
