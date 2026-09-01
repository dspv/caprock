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
import { api, errText, type GeminiReply, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Panel } from '@/components/ui'
import { fmtTokens } from '@/lib/format'

/** Prices below a cent, which is most of them, without rounding them to
 *  nothing: fmtUSD renders $0.002 as "$0.00", and a reader who believes a
 *  question is free will believe it fifty times. */
function fmtCents(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `${(usd * 100).toFixed(1)}\u00A2`
}

export function GeminiPanel() {
  // Fetched once, not polled: the key comes from the daemon's environment and
  // cannot change while it runs, and the licence is already polled by the
  // premium chip. A timer here bought nothing and outlived the test that
  // mounted it, firing into a torn-down jsdom.
  const status = useApi(() => api.gemini(), [], { live: false })
  const [prompt, setPrompt] = useState('')
  const [draftKey, setDraftKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [model, setModel] = useState('')
  const [reply, setReply] = useState<GeminiReply | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const st = status.data
  const ready = !!st?.available
  // Two things can be missing and they are independent. Behind the paywall the
  // panel is inert, so a reader who has set no key would otherwise see a text
  // box they cannot type in and no hint that a key is needed at all — the
  // setup step has to be visible whether or not they have bought anything.
  const needsKey = st !== undefined && !st.available

  const saveKey = async () => {
    const k = draftKey.trim()
    if (!k || savingKey) return
    setSavingKey(true)
    setKeyError('')
    try {
      await api.saveSettings({ gemini_api_key: k } as Partial<Settings> as Settings)
      setDraftKey('')
      status.refresh?.()
    } catch (e) {
      setKeyError(errText(e))
    } finally {
      setSavingKey(false)
    }
  }

  const ask = async () => {
    const q = prompt.trim()
    if (!q || busy) return
    setBusy(true)
    setError('')
    try {
      setReply(await api.askGemini(q, model || undefined))
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
      {needsKey ? (
        <div className="px-3 py-3 text-[12px] text-fg-muted grid gap-2.5">
          <p className="m-0">
            Ask Google&apos;s Gemini about your own sessions, on your own key. Get one from{' '}
            <a className="link" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              Google AI Studio
            </a>{' '}
            and paste it here — you pay Google directly, and Caprock counts what it spends
            beside your Claude figures.
          </p>
          {/* The field, rather than an environment variable.
            *
            * It used to say `export GEMINI_API_KEY=…` and nothing else, which
            * is no instruction at all for the people most likely to be here: a
            * login agent inherits nothing from a shell profile, so anyone who
            * ran `caprock service install` had to hand-edit a launchd plist to
            * switch on a paid feature. A key nobody can enter protects nothing
            * — the feature simply goes unused (ADR-025). */}
          <label className="grid gap-1">
            <span className="text-fg-muted">API key</span>
            <input
              className="input"
              type="password"
              placeholder="AIza…"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveKey() }}
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void saveKey()}
              disabled={savingKey || !draftKey.trim()}
              className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm hover:bg-accent/25 disabled:opacity-50"
            >
              {savingKey ? 'saving…' : 'Save key'}
            </button>
            <span className="text-[11px] text-fg-faint">
              Stored on this machine only, and never sent back to this page.
            </span>
          </div>
          {keyError && <div className="text-danger text-[11px]">{keyError}</div>}
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
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => void ask()}
              disabled={busy || !prompt.trim()}
              className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm text-[12px] hover:bg-accent/25 disabled:opacity-50"
            >
              {busy ? 'asking…' : 'Ask'}
            </button>
            {/* Priced, because the models differ by twenty-five times and it is
              * the reader's money. The figure is what a short question costs at
              * that model's rates — shown before spending rather than after. */}
            {(st?.models?.length ?? 0) > 0 && (
              <select
                className="input w-auto text-[12px] py-1"
                value={model || st?.model || ''}
                onChange={(e) => setModel(e.target.value)}
                aria-label="Model"
              >
                {st!.models!.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display} · ~{fmtCents(m.typical_usd)} a question
                  </option>
                ))}
              </select>
            )}
            <span className="text-[11px] text-fg-faint">⌘↵ to send</span>
          </div>

          {error && <div className="text-danger text-[12px]">{error}</div>}

          {/* Where the key is, stated even when it is working. Someone reading
            * a panel that spends money should be able to see what it spends
            * against without going to look for documentation. */}
          <p className="m-0 text-[11px] text-fg-faint">
            {st?.from_env
              ? <>Using the key in <span className="mono">{st?.env_var}</span>, which takes precedence over the stored one.</>
              : <>Using the key you saved here. Google bills you directly.</>}
          </p>

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
