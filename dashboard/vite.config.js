import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const previewApiTarget = process.env.VITE_PREVIEW_API_URL || 'http://127.0.0.1:4000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": {
        target: previewApiTarget,
        changeOrigin: true
      },
      "/health": {
        target: previewApiTarget,
        changeOrigin: true
      }
    }
  }
})
