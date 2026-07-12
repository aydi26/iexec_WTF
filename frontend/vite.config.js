import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  resolve: { alias: { iexec: new URL("./src/lib/iexec-stub.js", import.meta.url).pathname, jszip: new URL("./src/lib/jszip-stub.js", import.meta.url).pathname } },
  plugins: [react()],
})
