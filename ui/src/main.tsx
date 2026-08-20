import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted brand faces (same as caprock.dev) — bundled, never fetched at
// runtime, so the dashboard stays local-first with no outbound calls.
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '@/design/tokens.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
