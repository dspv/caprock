import { useState } from 'react'
import { CloseButton, DialogBackdrop } from './Dialog'
import { DirPicker } from './DirPicker'
import { AgentPicker, useAgentChoice, useSpawnableAgents, type SpawnAgent } from './AgentPicker'
import { api, errText, isPairedDevice } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { navigate } from '@/lib/router'
import { modeWords, useInitialMode } from '@/lib/permissionMode'
import { stepSelect } from '@/lib/selectKeys'
import { BypassConsentNote, useBypassConsent } from './BypassConsent'

// What the two selects start on, rather than an empty "default" that says
// nothing about what you are about to run. Opus is what the machine's own
// sessions use — the newest Opus, since an older one under a familiar name is
// the model nobody meant to pick. A new install starts on Accept edits, which
// asks before running a command (owner, 2026-10-08, ADR-043): Anthropic keeps
// bypass for isolated machines, and a first session on a work laptop should
// not be one that never asks. Bypass is one pick away, and the pick is kept
// (useInitialMode). A saved preference wins, and a bypass session started
// from a paired phone is still confirmed.
const DEFAULT_MODEL = 'claude-opus-5-5'
export const DEFAULT_MODE = 'acceptEdits'

// Labelled, because `bypassPermissions` is not a phrase anyone thinks in and
// the consequence is the part that matters.
// Gemini CLI is a coding agent in the same shape as Claude Code — it reads
// files, edits them and runs commands in a directory — so it belongs in this
// dialog rather than in a chat panel. Its models are Google's, and the prices
// differ by a factor of twenty-five, so they are named here too.
// Every id here answered a real prompt on a real key, and is one the pricing
// table can cost. Both halves are needed and neither is enough: the first list
// was written from memory and two of three did not exist; the second was
// checked against the CLI bundle and pricing.json, and still offered
// `gemini-2.5-flash-lite`, which Google has closed to new keys, and
// `gemini-3.1-pro-preview`, which a free key cannot call at all
// (`generate_content_free_tier_input_token_count, limit: 0`).
export const GEMINI_MODELS: [value: string, label: string][] = [
  ['gemini-3.5-flash-lite', 'Flash Lite 3.5 · cheapest'],
  ['gemini-2.5-flash', 'Flash 2.5 · older, cheap'],
  ['gemini-3.5-flash', 'Flash 3.5 · most capable'],
]

// Ordered most capable first, and labelled with the axis someone actually
// picks on: price relative to the others. The ranking is pricing.json's, per
// million output tokens (Fable 5.1 50, Opus 5.5 20, Sonnet 5.5 10, Haiku 5.5 0.5) — the figures
// the Cost screen bills these sessions with, not a remembered ordering.
//
// Each label stays within 25 characters: the New agent sheet gives the model
// half a row, in a monospace face, and a longer one was cut off mid-word
// (owner, 2026-10-09). A test holds every label to that width.
//
// Each label carries the exact version. "Opus 5" read as "the current Opus"
// to the owner, who picked it on 2026-10-07 and got the older model while
// Opus 5.5 was out and missing from this list. A family name without its
// version is a promise about recency the list cannot keep; the test against
// pricing.json fails the build when a newer model of a family is priced but
// not offered here.
//
// Fable 5 was missing entirely, which is the same failure the Gemini list
// above already made once: a list written from what came to mind rather than
// from what the machine can run. `claude --help` names `fable` alongside
// `opus` and `sonnet` as the aliases for the latest models, pricing.json
// carries `claude-fable-5`, and it answered a real prompt on this machine.
// `claude-mythos-5` is in pricing.json too and is deliberately NOT here: the
// real binary rejects it with "may not exist or you may not have access to
// it". Being in the pricing table means we can cost a model, never that this
// account can call it — the only proof that belongs in this list is a live
// answer from the real `claude`.
export const MODELS: [value: string, label: string][] = [
  ['claude-fable-5-1', 'Fable 5.1 · top, priciest'],
  ['claude-opus-5-5', 'Opus 5.5 · all-rounder'],
  ['claude-sonnet-5-5', 'Sonnet 5.5 · fast, cheap'],
  ['claude-haiku-5-5', 'Haiku 5.5 · cheapest'],
]

// The values Claude Code accepts (`claude --help`): acceptEdits, auto,
// bypassPermissions, manual, dontAsk, plan. The old list offered "default",
// which is not one of them, and "" — so the dialog could send a mode the
// binary rejects. Three are offered here; the rest are reachable by starting
// claude yourself, which Caprock watches all the same.
// Short enough to survive a narrow window. The label has to carry what the
// session will DO without being opened — a mode cut off mid-word ("asks before
// com…") is the one label where truncation hides the consequence.
// The modes the daemon can express as a Gemini --approval-mode; the rest fall
// back to Gemini's own default, which asks.
export const GEMINI_MAPPED = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'plan'])

export const MODES: [value: string, label: string][] = [
  ['acceptEdits', 'Accept edits · asks first'],
  ['plan', 'Plan · changes nothing'],
  ['bypassPermissions', 'Bypass · never asks'],
]

/** MODES, plus `current` when it is a mode they do not list — a session
 *  carried on in auto mode, or a preference set through the API — so a select
 *  never shows one mode while holding another. */
export function modeOptions(current: string): [value: string, label: string][] {
  if (!current || MODES.some(([v]) => v === current)) return MODES
  const w = modeWords(current)
  return [[current, w.charAt(0).toUpperCase() + w.slice(1)], ...MODES]
}

// What each mode becomes in an agent that spells it differently, read from
// that CLI's --help (codex-cli 0.160.0, opencode 1.15.10) and said in the
// label, so the choice names the consequence rather than Claude's word for it.
// The daemon builds the flags (internal/agents/argv.go); a mode an agent has
// no honest counterpart for is left to that agent's own config and marked.
export const MODE_NOTE: Partial<Record<SpawnAgent, Record<string, string>>> = {
  codex: {
    acceptEdits: 'Accept edits · workspace sandbox, asks first',
    plan: 'Plan · read-only sandbox',
    bypassPermissions: 'Bypass · no sandbox, never asks',
  },
  opencode: {
    acceptEdits: 'Accept edits · asks before commands',
    plan: "Plan · OpenCode's plan agent",
    bypassPermissions: "Bypass · OpenCode's own rules",
  },
}

/** OpenCode 2 (2.0.26) has the flag OpenCode 1 lacked: `--auto`, "auto-approve
 *  permissions that are not explicitly denied", so bypass is real there. The
 *  other two are the same plan agent and the same ask-before-commands rule,
 *  given as config rather than flags. */
export const OPENCODE2_MODE_NOTE: Record<string, string> = {
  ...MODE_NOTE.opencode,
  bypassPermissions: "Bypass · approves all it doesn't deny",
}

/** The major version in "2.0.26", 0 when unknown. */
export function majorVersion(v?: string): number {
  const n = Number((v ?? '').split('.')[0])
  return Number.isFinite(n) ? n : 0
}

/** What each mode is called for this agent, given the daemon's status: the
 *  installed OpenCode's major version decides which OpenCode's words. */
export function modeNotes(agent: SpawnAgent, opencodeVersion?: string): Record<string, string> | undefined {
  if (agent === 'opencode' && majorVersion(opencodeVersion) >= 2) return OPENCODE2_MODE_NOTE
  return MODE_NOTE[agent]
}

/** The model a session starts on, per agent. Codex and OpenCode start on
 *  whatever the user's own config names, which Caprock does not try to
 *  restate; "" means exactly that. */
export const DEFAULT_MODELS: Record<SpawnAgent, string> = {
  claude: DEFAULT_MODEL,
  gemini: GEMINI_MODELS[0]![0],
  codex: '',
  opencode: '',
}

export function SpawnDialog({
  available,
  geminiAvailable = false,
  agents: given,
  onClose,
  // Where to start, when the caller already knows. Opening this from a session
  // whose repository is on screen and then asking for the directory again is
  // asking someone to retype what they are looking at.
  initialCwd = '',
  landOn = 'terminal',
}: {
  /** Whether Claude Code can be started. Kept for callers that know only
   *  that; the dialog asks the daemon about the other agents itself. */
  available: boolean
  /** Whether the Gemini CLI is on PATH. */
  geminiAvailable?: boolean
  /** The agents to offer, when the caller already knows them. */
  agents?: SpawnAgent[]
  onClose: () => void
  initialCwd?: string
  /** The session's tab to open once started: the phone's start-work flow lands on the chat. */
  landOn?: 'terminal' | 'chat'
}) {
  const fetched = useSpawnableAgents({ claude_available: available, gemini_available: geminiAvailable })
  const agents = given ?? fetched
  const [agent, setAgent] = useAgentChoice(agents)
  const [cwd, setCwd] = useState(initialCwd)
  const [models, setModels] = useState<Record<SpawnAgent, string>>(DEFAULT_MODELS)
  const model = models[agent]
  const setModel = (v: string) => setModels((m) => ({ ...m, [agent]: v }))
  // Opens on the Settings preference when one is set (New sessions).
  const [mode, setMode, rememberMode] = useInitialMode(DEFAULT_MODE)
  // Codex keeps its own model catalog on disk; the daemon reads it so the
  // list is the one Codex itself offers this account, not one written here.
  const codexModels = useApi(() => (agent === 'codex' ? api.agentModels('codex') : Promise.resolve(undefined)), [agent], { live: false })
  // Which OpenCode is installed decides what a mode becomes in it.
  const status = useApi(() => api.status(), [], { live: false })
  const notes = modeNotes(agent, status.data?.opencode_version)
  const [worktree, setWorktree] = useState('')
  const [create, setCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // On a paired phone (a controller, or this dialog is not shown): the same
  // dialog, with folders under home only (the daemon enforces it, ADR-034),
  // and one confirm before a session that never asks — nobody may be at the
  // machine to notice what it does.
  const remote = isPairedDevice()
  const [confirming, setConfirming] = useState(false)
  const consent = useBypassConsent(agent, mode)
  const submit = async () => {
    if (!cwd.trim()) { setError('Working directory is required.'); return }
    if (remote && mode === 'bypassPermissions' && !confirming) { setConfirming(true); return }
    setConfirming(false)
    setBusy(true); setError('')
    try {
      if (consent.needed) await consent.accept()
      const req: Parameters<typeof api.spawn>[0] = { cwd: cwd.trim() }
      if (agent !== 'claude') req.agent = agent
      if (model.trim()) req.model = model.trim()
      // Every agent takes the mode in Claude's vocabulary; the daemon
      // translates it, or leaves it off where the agent has no counterpart.
      if (mode) req.permission_mode = mode
      if (worktree.trim()) req.worktree = worktree.trim()
      if (create) req.create = true
      const { session_id } = await api.spawn(req)
      rememberMode()
      onClose()
      navigate({ name: 'session', id: session_id, tab: landOn })
    } catch (e) {
      // errText also surfaces `detail`, the half that says what to do about it.
      if (!consent.noteRefusal(e)) setError(errText(e))
    } finally { setBusy(false) }
  }
  return (
    <DialogBackdrop onClose={onClose} className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-4 sm:pt-24">
      <div role="dialog" aria-modal="true" aria-label="New session" className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[620px] max-w-[94vw] max-h-[calc(100dvh-2rem)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center">
          <h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">New session</h2>
          <CloseButton onClick={onClose} className="-my-1 ml-auto" />
        </header>
        {!available && agents.length === 0 ? (
          <div className="px-4 py-6 text-[13px] text-fg-muted">
            No coding agent Caprock can start was found on this machine — not <span className="mono">claude</span>, <span className="mono">codex</span>, <span className="mono">opencode</span> or <span className="mono">gemini</span>. It still observes every session you start yourself.
          </div>
        ) : (
          // min-w-0 here and on every Field below: a grid item will not shrink
          // below its content by default, so the long paths in the picker
          // widened the dialog itself — 738px of list inside a 520px panel,
          // running past its border. Clipping inside the picker cannot fix
          // that; the container has to be allowed to be narrower than what it
          // holds.
          // ↑ and ↓ change a select in place, as in the app's New agent sheet.
          <div className="px-4 py-3 grid min-w-0 gap-3 text-[13px]" onKeyDown={(e) => { stepSelect(e) }}>
            <Field label="Working directory" hint={remote ? 'a folder under your home' : 'pick one, or type a path'}>
              {/* No autofocus on a phone: it would open the keyboard over the
                * picker the phone is meant to use. 16px there, or iOS zooms;
                * inline, because .input's own size outranks a utility. */}
              <input autoFocus={!remote} className="input" style={remote ? { fontSize: 16 } : undefined} placeholder="/Users/you/dev/project" value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
              {/* The lists write into the field above rather than replacing it,
                * so what will actually be used stays visible and editable. */}
              <div className="mt-1.5 min-w-0 max-w-full">
                <DirPicker value={cwd} onPick={setCwd} />
              </div>
            </Field>
            {/* Only the agents whose binary the daemon found: a choice that
              * fails on click is worse than no choice. The last one picked
              * is remembered for this viewer. */}
            <AgentPicker value={agent} agents={agents} onChange={setAgent} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Model" hint={agent === 'opencode' ? 'provider/model' : undefined}>
                <ModelField
                  agent={agent}
                  value={model}
                  onChange={setModel}
                  codex={codexModels.data}
                />
              </Field>
              {/* Every agent covers the same ground with its own words, and
                * the daemon maps onto them — so the control stays live for
                * all of them, labelled with what it becomes in this one. */}
              <Field label="Permissions" hint={remote ? undefined : 'kept for the next agent'}>
                <select className="input" value={mode} onChange={(e) => { setMode(e.target.value); setConfirming(false) }}>
                  {modeOptions(mode).map(([v, label]) => (
                    <option key={v} value={v}>
                      {agent === 'gemini' && !GEMINI_MAPPED.has(v) ? `${label} · Gemini asks instead` : notes?.[v] ?? label}
                    </option>
                  ))}
                </select>
              </Field>
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
            {consent.needed && <BypassConsentNote />}
            {error && <div className="text-danger text-[12px]">{error}</div>}
          </div>
        )}
        {(available || agents.length > 0) && confirming && (
          // Inline, not window.confirm: a browser dialog on a phone is easy to
          // dismiss without reading, and some in-app browsers suppress it.
          <footer role="alertdialog" aria-label="Confirm bypass" className="px-4 py-2 border-t border-border grid gap-2 text-[13px]">
            <p className="text-warn">The agent won't ask before running commands or editing files. Start?</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirming(false)} className="border border-border px-3 py-1 rounded-sm max-sm:min-h-11 max-sm:px-4 text-fg-muted hover:text-fg">Back</button>
              <button onClick={submit} disabled={busy} className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm max-sm:min-h-11 max-sm:px-4 hover:bg-accent/25 disabled:opacity-50">{busy ? 'starting…' : 'Start in bypass'}</button>
            </div>
          </footer>
        )}
        {(available || agents.length > 0) && !confirming && (
          <footer className="px-4 py-2 border-t border-border flex gap-2 justify-end">
            <button onClick={onClose} className="border border-border px-3 py-1 rounded-sm max-sm:min-h-11 max-sm:px-4 text-fg-muted hover:text-fg">Cancel</button>
            <button onClick={submit} disabled={busy} className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm max-sm:min-h-11 max-sm:px-4 hover:bg-accent/25 disabled:opacity-50">{busy ? 'starting…' : consent.needed ? 'Accept and start' : 'Start session'}</button>
          </footer>
        )}
      </div>
    </DialogBackdrop>
  )
}

/** The model control for one agent. Claude Code and Gemini get a checked list;
 *  Codex its own catalog, with its configured default first; OpenCode a field,
 *  because its models are whatever providers the user set up, written
 *  provider/model. Empty means "what your own config says". */
export function ModelField({
  agent,
  value,
  onChange,
  codex,
}: {
  agent: SpawnAgent
  value: string
  onChange: (v: string) => void
  codex?: { default?: string; models: { id: string; label: string }[] }
}) {
  if (agent === 'claude' || agent === 'gemini') {
    return (
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {(agent === 'gemini' ? GEMINI_MODELS : MODELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
    )
  }
  if (agent === 'codex') {
    const listed = codex?.models ?? []
    return (
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {/* Short enough for the New agent sheet's half-width column: the
          * longer "· your Codex default" was cut off there (owner, 2026-10-09). */}
        <option value="">{codex?.default ? `${codex.default} (default)` : 'Codex default'}</option>
        {listed.filter((m) => m.id !== codex?.default).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    )
  }
  return (
    <input
      className="input"
      placeholder="your OpenCode default"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
    />
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
