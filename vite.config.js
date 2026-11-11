import { defineConfig } from 'vite'
import { officeApi } from './server/api.js'

// Load API keys / Vertex settings from a local .env (gitignored) so the API server can use them.
try { process.loadEnvFile('.env') } catch {}

export default defineConfig({
  plugins: [officeApi()],
})
