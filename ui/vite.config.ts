/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

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

// The phone's page in Safari on an iPhone offers Caprock for iPhone (ADR-083)
// through Apple's Smart App Banner: a person who scanned the pairing code with
// the camera lands here and would otherwise never learn the app exists. Only
// the remote build carries it; Safari alone draws it, never the app's own web
// view, a home-screen copy or any other browser.
const appBanner = {
  name: 'caprock-app-banner',
  transformIndexHtml: (html: string) =>
    html.replace('</head>', '    <meta name="apple-itunes-app" content="app-id=6827747312" />\n  </head>'),
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'remote' ? [appBanner] : [])],
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
