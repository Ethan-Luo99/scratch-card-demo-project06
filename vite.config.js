import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/fabric/')) return 'fabric'
          if (id.includes('/src/scratch-card/')) return 'scratch-card'
        },
      },
    },
  },
})
