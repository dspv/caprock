/**
 * Ask Gemini — the second paid feature, and the first that spends money.
 *
 * The shape of it is set by one decision (ADR-023): the key is not ours. It
 * lives in the daemon's environment, Caprock never stores it and this page
 * never sees it, so a bug here cannot leak a credential. What that costs is a
 * worse first run — you set a variable and restart — and the panel says so
 * plainly rather than pretending a field is missing.
 *
 * Two things can be absent, and they are different problems with different
 * fixes, so the panel never merges them into one dead button:
 *
 *  - **No key.** Nothing to do with money. The feature is simply not set up on
 *    this machine, and the answer is a variable name.
 *  - **No licence.** The key works, the feature is bought rather than built.
 *    The server refuses the call, so this is not a decoration over a working
 *    button — see the 402 in internal/api/gemini.go.
 *
 * What it costs is shown after every answer, from the response's own token
 * counts. That figure is what Caprock sent, not what Google billed: there is
 * no per-key billing API to reconcile against, and saying so is cheaper than
 * being caught rounding.
 */
import { useState } from 'react'
import { api, errText, type GeminiReply } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Panel } from '@/components/ui'
import { fmtTokens } from '@/lib/format'

export function GeminiPanel() {
  const status = useApi(() => api.gemini(), [], { live: false, intervalMs: 30000 })
  const [prompt, setPrompt] = useState('')
  const [reply, setReply] = useState<GeminiReply | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const st = status.data
  const ready = !!st?.available

  const ask = async () => {
    const q = prompt.trim()
    if (!q || busy) return
    setBusy(true)
    setError('')
    try {
      setReply(await api.askGemini(q))
      setPrompt('')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="Ask Gemini"
      right={
        <span className="text-[11px] text-fg-faint">
          {ready ? st?.model : 'your key, your bill'}
        </span>
      }
    >
      {/* The setup case comes first because it is the one a reader can act on
        * without paying anything. */}
      {!ready ? (
        <div className="px-3 py-3 text-[12px] text-fg-muted grid gap-2">
          <p className="m-0">
            Caprock can ask Google&apos;s Gemini on your own key. It never stores the key —
            set it in the daemon&apos;s environment and restart:
          </p>
          <code className="mono text-[11px] bg-panel-2 px-2 py-1.5 rounded-sm text-fg block overflow-x-auto">
            export {st?.env_var ?? 'GEMINI_API_KEY'}=…
          </code>
          <p className="m-0 text-fg-faint">
            Get one from Google AI Studio. You pay Google directly; Caprock only counts what it sent.
          </p>
        </div>
      ) : (
        <div className="px-3 py-3 grid gap-2">
          <textarea
            className="input min-h-[70px] resize-y"
            placeholder="Ask about your sessions, your spend, anything…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            /* Cmd/Ctrl+Enter sends, plain Enter breaks a line: this is a box
             * people will paste a paragraph into. */
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void ask()
            }}
          />
          <div className="flex items-center gap-3">
            <button
              onClick={() => void ask()}
              disabled={busy || !prompt.trim()}
              className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm text-[12px] hover:bg-accent/25 disabled:opacity-50"
            >
              {busy ? 'asking…' : 'Ask'}
            </button>
            <span className="text-[11px] text-fg-faint">⌘↵ to send</span>
          </div>

          {error && <div className="text-danger text-[12px]">{error}</div>}

          {reply && (
            <div className="grid gap-2 border-t border-border pt-2">
              <div className="text-[13px] whitespace-pre-wrap">{reply.text}</div>
              {/* Counted from the response, and labelled as such. The cost of
                * this turn lands in Cost and Lifetime with everything else,
                * priced by the same table. */}
              <div className="text-[11px] text-fg-faint num flex gap-3 flex-wrap">
                <span>{reply.model}</span>
                <span>in {fmtTokens(reply.usage.prompt_tokens)}</span>
                <span>out {fmtTokens(reply.usage.output_tokens)}</span>
                {reply.usage.thoughts_tokens > 0 && (
                  <span title="Google bills thinking tokens as output">
                    thinking {fmtTokens(reply.usage.thoughts_tokens)}
                  </span>
                )}
                {reply.usage.cached_tokens > 0 && <span>cached {fmtTokens(reply.usage.cached_tokens)}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
