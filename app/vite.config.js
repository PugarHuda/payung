import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `vite preview` serves the same security headers as Vercel (vercel.json is the one source), so
// the e2e suite runs under the production CSP. A fork test's local RPC is allowed only when set.
const headers = Object.fromEntries(JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url))).headers[0].headers.map((h) => [h.key, h.value]))
for (const url of [process.env.VITE_MEZO_RPC, process.env.VITE_RELAY_URL].filter(Boolean)) headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace('connect-src', `connect-src ${new URL(url).origin}`)

export default defineConfig({ plugins: [react()], base: './', preview: { headers } })
