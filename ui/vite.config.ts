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
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
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
      '/v1': { target: 'http://127.0.0.1:22776', ws: true },
      '/healthz': { target: 'http://127.0.0.1:22776' },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
}))
