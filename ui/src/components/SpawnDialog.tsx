import { useState } from 'react'
import { DirPicker } from './DirPicker'
import { api, errText } from '@/lib/api'
import { navigate } from '@/lib/router'

// What the two selects start on, rather than an empty "default" that says
// nothing about what you are about to run. Opus is what the machine's own
// sessions use, and asking before editing is the setting you can leave a
// session alone with — a dialog whose defaults you would not choose is a
// dialog you have to read every time.
const DEFAULT_MODEL = 'claude-opus-5'
const DEFAULT_MODE = 'acceptEdits'

// Labelled, because `bypassPermissions` is not a phrase anyone thinks in and
// the consequence is the part that matters.
// Gemini CLI is a coding agent in the same shape as Claude Code — it reads
// files, edits them and runs commands in a directory — so it belongs in this
// dialog rather than in a chat panel. Its models are Google's, and the prices
// differ by a factor of twenty-five, so they are named here too.
const GEMINI_MODELS: [value: string, label: string][] = [
  ['gemini-3.5-flash-lite', 'Flash Lite · cheapest'],
  ['gemini-3.7-flash', 'Flash 3.7 · balanced'],
  ['gemini-3.1-pro-preview', 'Pro 3.1 · most capable'],
]

const MODELS: [value: string, label: string][] = [
  ['claude-opus-5', 'Opus 5 · most capable'],
  ['claude-sonnet-5', 'Sonnet 5 · faster, cheaper'],
  ['claude-haiku-4-5', 'Haiku 4.5 · cheapest'],
]

// The values Claude Code accepts (`claude --help`): acceptEdits, auto,
// bypassPermissions, manual, dontAsk, plan. The old list offered "default",
// which is not one of them, and "" — so the dialog could send a mode the
// binary rejects. Three are offered here; the rest are reachable by starting
// claude yourself, which Caprock watches all the same.
// Short enough to survive a narrow window. The label has to carry what the
// session will DO without being opened — a mode cut off mid-word ("asks before
// com…") is the one label where truncation hides the consequence.
const MODES: [value: string, label: string][] = [
  ['acceptEdits', 'Accept edits · asks first'],
  ['plan', 'Plan · changes nothing'],
  ['bypassPermissions', 'Bypass · never asks'],
]

export function SpawnDialog({
  available,
  geminiAvailable = false,
  onClose,
  // Where to start, when the caller already knows. Opening this from a session
  // whose repository is on screen and then asking for the directory again is
  // asking someone to retype what they are looking at.
  initialCwd = '',
}: {
  available: boolean
  /** Whether the Gemini CLI is on PATH, so the agent picker is worth showing. */
  geminiAvailable?: boolean
  onClose: () => void
  initialCwd?: string
}) {
  const [cwd, setCwd] = useState(initialCwd)
  const [agent, setAgent] = useState<'claude' | 'gemini'>('claude')
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [mode, setMode] = useState(DEFAULT_MODE)
  const [worktree, setWorktree] = useState('')
  const [create, setCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!cwd.trim()) { setError('Working directory is required.'); return }
    setBusy(true); setError('')
    try {
      const req: Parameters<typeof api.spawn>[0] = { cwd: cwd.trim() }
      if (agent !== 'claude') req.agent = agent
      if (model) req.model = model
      // Gemini CLI has no permission modes; sending one would be a flag it
      // does not understand.
      if (mode && agent === 'claude') req.permission_mode = mode
      if (worktree.trim()) req.worktree = worktree.trim()
      if (create) req.create = true
      const { session_id } = await api.spawn(req)
      onClose()
      navigate({ name: 'session', id: session_id, tab: 'terminal' })
    } catch (e) {
      // errText also surfaces `detail`, the half that says what to do about it.
      setError(errText(e))
    } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-24" onClick={onClose}>
      <div className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[620px] max-w-[94vw]" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center">
          <h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">New session</h2>
          <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">✕</button>
        </header>
        {!available ? (
          <div className="px-4 py-6 text-[13px] text-fg-muted">
            The <span className="mono">claude</span> binary was not found on this machine, so Caprock cannot spawn sessions. It still observes every session you start yourself.
          </div>
        ) : (
          // min-w-0 here and on every Field below: a grid item will not shrink
          // below its content by default, so the long paths in the picker
          // widened the dialog itself — 738px of list inside a 520px panel,
          // running past its border. Clipping inside the picker cannot fix
          // that; the container has to be allowed to be narrower than what it
          // holds.
          <div className="px-4 py-3 grid min-w-0 gap-3 text-[13px]">
            <Field label="Working directory" hint="pick one, or type a path">
              <input autoFocus className="input" placeholder="/Users/you/dev/project" value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
              {/* The lists write into the field above rather than replacing it,
                * so what will actually be used stays visible and editable. */}
              <div className="mt-1.5 min-w-0 max-w-full">
                <DirPicker value={cwd} onPick={setCwd} />
              </div>
            </Field>
            {/* Only offered when the machine has both: a choice that fails on
              * click is worse than no choice. */}
            {geminiAvailable && (
              <Field label="Agent">
                <select
                  className="input"
                  value={agent}
                  onChange={(e) => {
                    const next = e.target.value as 'claude' | 'gemini'
                    setAgent(next)
                    // The model lists do not overlap, so carrying the old
                    // selection across would launch with a model the agent
                    // has never heard of.
                    setModel(next === 'gemini' ? GEMINI_MODELS[0]![0] : DEFAULT_MODEL)
                  }}
                >
                  <option value="claude">Claude Code</option>
                  <option value="gemini">Gemini CLI · your own key</option>
                </select>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Model"><select className="input" value={model} onChange={(e) => setModel(e.target.value)}>{(agent === 'gemini' ? GEMINI_MODELS : MODELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></Field>
              <Field label={agent === 'gemini' ? 'Permissions · not used by Gemini' : 'Permissions'}><select disabled={agent === 'gemini'} className="input" value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></Field>
            </div>
            {/* Two settings that matter to a handful of runs and to nobody
              * else, folded away rather than deleted. Every field on screen is
              * a decision asked of someone who wanted to press one button. */}
            <details className="text-[12px] group">
              <summary className="cursor-pointer select-none text-fg-muted hover:text-fg list-none marker:content-none">
                <span className="inline-block transition-transform group-open:rotate-90 text-fg-faint">▶</span> Advanced
              </summary>
              <div className="grid gap-2 pt-2">
                {/* Starting a new project meant leaving the dashboard, making
                  * the folder in a terminal, and coming back — for a directory
                  * whose name you had already typed here. Off by default:
                  * creating a directory is a side effect, and a typo in an
                  * absolute path should fail rather than quietly take up
                  * residence. */}
                <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-fg-muted">
                  <input type="checkbox" className="accent-[var(--color-accent)]" checked={create} onChange={(e) => setCreate(e.target.checked)} />
                  create the directory if it does not exist
                </label>
                <Field label="Git worktree" hint="creates .caprock-worktrees/<name> on a new branch">
                  <input className="input" placeholder="feature-x" value={worktree} onChange={(e) => setWorktree(e.target.value)} />
                </Field>
              </div>
            </details>
            {error && <div className="text-danger text-[12px]">{error}</div>}
          </div>
        )}
        {available && (
          <footer className="px-4 py-2 border-t border-border flex gap-2 justify-end">
            <button onClick={onClose} className="border border-border px-3 py-1 rounded-sm text-fg-muted hover:text-fg">Cancel</button>
            <button onClick={submit} disabled={busy} className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm hover:bg-accent/25 disabled:opacity-50">{busy ? 'starting…' : 'Start session'}</button>
          </footer>
        )}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1">
      <span className="text-[11px] text-fg-muted">{label}{hint && <span className="text-fg-faint"> · {hint}</span>}</span>
      {children}
    </label>
  )
}
