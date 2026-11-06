/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { cpSync } from 'node:fs'
import type { Plugin } from 'vite'

// The dashboard is embedded into the Go binary from internal/api/dist (go:embed).
// In dev, Vite serves the UI on :5173 and proxies the API/WS to the daemon on :22776.
//
// `--mode remote` builds the phone's page instead (ADR-058): the same
// dashboard behind remote/RemoteRoot, which reaches its machine through a
// relay. It is served from its own https origin, never embedded.
//
// CAPROCK_DAEMON_URL points the proxy at another daemon: `make e2e` serves its
// build with `vite preview` (which uses the same proxy) in front of a
// sandboxed daemon on a free port (ui/e2e/stand.ts).
const daemon = process.env.CAPROCK_DAEMON_URL || 'http://127.0.0.1:22776'

// ui/public-remote/ goes into the phone's page only, never the dashboard:
// m.caprock.dev's apple-app-site-association (the pairing link opens the iOS
// app) and the _headers that serves it as JSON (relay/m, Workers assets).
function remoteFiles(): Plugin {
  return {
    name: 'caprock-remote-files',
    apply: 'build',
    writeBundle(opts) {
      cpSync(fileURLToPath(new URL('./public-remote', import.meta.url)), opts.dir!, { recursive: true })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'remote' ? [remoteFiles()] : [])],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: mode === 'remote' ? { 'import.meta.env.VITE_CAPROCK_REMOTE': JSON.stringify('1') } : {},
  build: {
    outDir: mode === 'remote' ? 'dist-remote' : '../internal/api/dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: daemon, ws: true },
      '/healthz': { target: daemon },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
}))
