import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxy = {
  target: 'http://127.0.0.1:8787',
  changeOrigin: true,
  timeout: 0,
  proxyTimeout: 0,
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': apiProxy },
  },
  preview: {
    proxy: { '/api': apiProxy },
  },
})
