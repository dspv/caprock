/**
 * The permission mode a new agent starts in, and the control that picks it.
 *
 * Three segments side by side rather than a select (owner, 2026-11-20,
 * translated: "not a dropdown but a selector with all the options — there are
 * only three — so it is visible at once, and clear where the most autonomy is
 * and what to expect, super short"). Left to right is more on its own: Plan
 * ●○○, Accept edits ●●○, Bypass ●●●, each with what to expect in two or
 * three words for the chosen agent, the agent's whole wording on hover and in
 * the accessible name. A radiogroup: Tab enters on the checked one, the arrow
 * keys move and pick, Tab leaves.
 */
import { useId, useRef, type KeyboardEvent } from 'react'
import { modeWords } from '@/lib/permissionMode'
import type { SpawnAgent } from './AgentPicker'


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

// Ordered by how much the agent does on its own, least first: the picker
// reads left to right as a scale (owner, 2026-11-20), and Settings and the
// continue menu list them the same way.
export const MODES: [value: string, label: string][] = [
  ['plan', 'Plan · changes nothing'],
  ['acceptEdits', 'Accept edits · asks first'],
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
  // Hermes (`hermes chat --help`, 0.21.6) has one switch: --yolo skips its
  // approval prompts for dangerous commands. It has no plan or accept-edits
  // mode, so those start Hermes as it is.
  hermes: {
    acceptEdits: 'Default · Hermes asks before risky commands',
    plan: 'Default · Hermes has no plan mode',
    bypassPermissions: 'Bypass · --yolo, never asks',
  },
  // cursor-agent (`--help`, 2025.09.12): -f/--force allows commands unless
  // they are explicitly denied. Plan exists only in newer CLIs as --mode, so
  // plan and accept-edits start Cursor as it is.
  cursor: {
    acceptEdits: 'Default · Cursor asks before commands',
    plan: 'Default · plan is not a flag every Cursor CLI has',
    bypassPermissions: 'Bypass · --force, runs what is not denied',
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

// What to expect, in the two or three words a segment's second line holds at
// the sheet's width (it wraps on a phone rather than being cut: a consequence
// cut off mid-word is the one label truncation must not hide). The agent's
// own wording in full, from MODE_NOTE, is the hover and the accessible name.
const SHORT: Record<string, string> = {
  plan: 'changes nothing',
  acceptEdits: 'asks before commands',
  bypassPermissions: 'never asks',
}

export const MODE_SHORT: Partial<Record<SpawnAgent, Record<string, string>>> = {
  codex: { plan: 'read-only sandbox', acceptEdits: 'sandbox, asks first', bypassPermissions: 'no sandbox, never asks' },
  opencode: { plan: 'its plan agent', acceptEdits: 'asks before commands', bypassPermissions: "OpenCode's own rules" },
  hermes: { plan: 'no plan mode: asks', acceptEdits: 'asks before risky ones', bypassPermissions: '--yolo, never asks' },
  cursor: { plan: 'no plan flag: asks', acceptEdits: 'asks before commands', bypassPermissions: "runs what isn't denied" },
}
const OPENCODE2_SHORT: Record<string, string> = { ...MODE_SHORT.opencode, bypassPermissions: "approves what it doesn't deny" }

/** The second line under each mode for this agent. */
export function modeShorts(agent: SpawnAgent, opencodeVersion?: string): Record<string, string> {
  if (agent === 'opencode' && majorVersion(opencodeVersion) >= 2) return OPENCODE2_SHORT
  return { ...SHORT, ...MODE_SHORT[agent] }
}

// How much each mode does on its own, drawn as dots in the colour of what it
// risks: blue reads, amber edits, red runs anything. The colours are the
// theme's progress, warn and danger marks, held at 3:1 or more in every theme.
const DOTS: Record<string, [dots: string, color: string]> = {
  plan: ['●○○', 'text-progress'],
  acceptEdits: ['●●○', 'text-warn'],
  bypassPermissions: ['●●●', 'text-danger'],
}

/** The mode's name without its note: "Accept edits · asks first" → "Accept edits". */
function nameOf(label: string): string {
  return label.split(' · ')[0] ?? label
}

export function PermissionPicker({
  value,
  onChange,
  agent,
  opencodeVersion,
  label = 'Permissions',
  hint,
  labelClassName = 'flex items-baseline gap-2 text-[13px] font-medium text-fg-muted',
}: {
  value: string
  onChange: (mode: string) => void
  agent: SpawnAgent
  /** The installed OpenCode's version, which decides what bypass is called there. */
  opencodeVersion?: string
  label?: string
  hint?: string
  /** The field label's style, to match the form it sits in. */
  labelClassName?: string
}) {
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const notes = modeNotes(agent, opencodeVersion)
  const shorts = modeShorts(agent, opencodeVersion)
  const at = MODES.findIndex(([v]) => v === value)
  // A mode the three do not list — auto mode carried from a session, or a
  // preference set through the API — is said on a line under the control
  // rather than as a fourth segment: it is rare, it has no place on the
  // left-to-right scale, and a fourth segment would not fit a phone.
  const extra = value && at < 0 ? value : ''
  const extraWords = extra ? modeWords(extra) : ''
  const geminiAsks = extra && agent === 'gemini' && !GEMINI_MAPPED.has(extra)
  const pick = (i: number) => {
    const n = MODES.length
    const j = ((i % n) + n) % n
    onChange(MODES[j]![0])
    refs.current[j]?.focus()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
    const from = at < 0 ? refs.current.findIndex((b) => b === document.activeElement) : at
    let to: number
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = from + 1
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = from < 0 ? MODES.length - 1 : from - 1
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = MODES.length - 1
    else return
    e.preventDefault()
    pick(to)
  }
  return (
    <div className="grid min-w-0 gap-1.5" data-permission-picker>
      <span id={`${id}-l`} className={labelClassName}>
        {label}
        {hint && <span className="font-normal text-fg-faint">{hint}</span>}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        aria-describedby={extra ? `${id}-x` : undefined}
        onKeyDown={onKeyDown}
        className="@container grid min-w-0 grid-cols-3 gap-[3px] rounded-[8px] border border-border bg-panel-2 p-[3px]"
      >
        {MODES.map(([v, modeLabel], i) => {
          const on = i === at
          const name = nameOf(modeLabel)
          const own = notes?.[v]
          // The agent's own wording where it has one, else the short line.
          const said = own?.includes(' · ') ? own.slice(own.indexOf(' · ') + 3) : shorts[v] ?? ''
          const full = own ?? `${name} · ${said}`
          const [dots, color] = DOTS[v] ?? ['', '']
          return (
            <button
              key={v}
              ref={(el) => { refs.current[i] = el }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${name}: ${said}`}
              title={full}
              tabIndex={on || (at < 0 && i === 0) ? 0 : -1}
              onClick={() => onChange(v)}
              data-mode={v}
              className={`grid min-w-0 content-start gap-px rounded-[6px] px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                on ? 'bg-panel shadow-[inset_0_0_0_1px_var(--color-border-strong)]' : 'hover:bg-panel/60'
              }`}
            >
              <span className={`flex min-w-0 items-center gap-1.5 text-[13px] font-semibold @max-[22rem]:flex-col @max-[22rem]:items-start @max-[22rem]:gap-0 ${on ? 'text-fg' : 'text-fg-muted'}`}>
                <span aria-hidden className={`shrink-0 text-[10px] leading-none tracking-[1px] ${color}`}>{dots}</span>
                <span className="min-w-0 truncate">{name}</span>
              </span>
              <span className="text-[11.5px] leading-snug text-fg-faint">{shorts[v]}</span>
            </button>
          )
        })}
      </div>
      <div aria-hidden className="flex justify-between px-1 text-[11px] text-fg-faint">
        <span>safer</span>
        <span>more on its own →</span>
      </div>
      {extra && (
        <p id={`${id}-x`} className="text-[12px] text-fg-muted" data-extra-mode={extra}>
          Starts in <span className="font-medium text-fg">{extraWords}</span>
          {geminiAsks ? ' (Gemini asks instead)' : ''} · pick one above to change it
        </p>
      )}
    </div>
  )
}
