import { defineConfig } from 'vite'

/** Bundles the sheet renderer for Node, used by npm run render:sheets. */
export default defineConfig({
  build: {
    ssr: 'scripts/render-sheet.tsx',
    outDir: 'scripts/dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
  },
})
