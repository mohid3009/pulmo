import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// host: true so phones on the same network can open it over http.
export default defineConfig({
  plugins: [react()],
  server: { host: true },
  preview: { host: true },
})
