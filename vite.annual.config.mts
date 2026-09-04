import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import { resolve } from 'node:path'

// Standalone webpage build; the main Vite build includes this same HTML entry.
export default defineConfig({
  base: './',
  plugins: [vue()],
  define: { 'import.meta.client': 'true' },
  resolve: { alias: { '~': resolve('annual-v2') } },
  css: { postcss: { plugins: [tailwindcss('./annual-v2/tailwind.config.cjs'), autoprefixer()] } },
  server: { port: 3012, open: '/annual-v2/index.html' },
  build: { outDir: 'dist-annual-v2', rollupOptions: { input: resolve('annual-v2/index.html') } }
})
