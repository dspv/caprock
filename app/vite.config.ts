import { defineConfig } from 'vite'

// One IIFE (JS + xterm.css inlined) that the Rust side injects as a webview
// initialization script. See src-tauri/src/main.rs for why it is injected
// rather than served from the app's own origin.
export default defineConfig({
  build: {
    outDir: 'dist-term',
    emptyOutDir: true,
    minify: true,
    lib: { entry: 'term/main.ts', formats: ['iife'], name: 'CaprockTerm', fileName: () => 'term.js' },
  },
})
