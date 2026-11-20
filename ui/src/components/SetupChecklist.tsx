/**
 * The setup checklist on the computer that runs agents (ADR-099): what it
 * needs before agents can run here and be started from the laptop, read from
 * `GET /v1/setup` — Git, the agents, the link, and projects here — each with
 * the one button that does it.
 *
 * - **Agents** (owner, 2026-11-20, variant A2 of the mockup): a row per agent
 *   Caprock can start, each with a switch. Switched on, the row says that
 *   agent's state and its one next step — Install, Add to PATH, Sign in —
 *   then *Signed in. Ready.* Switched off, it is grey and not counted. The
 *   switches are kept by this computer's daemon, so the laptop and
 *   `caprock setup` see the same.
 * - **Install / Add to PATH / Sign in** open a shell tab with the command
 *   typed, not run: the user reads it and presses Enter (ADR-046; the owner
 *   accepted it for this, 2026-11-20, translated: "if it is really needed,
 *   ok"). In a browser, where there are no tabs, the command is shown to copy
 *   with where to run it.
 * - **Link to your laptop** holds Turn on and Show the link (`link`).
 * - **Projects here** is last and optional, a dashed circle: agents start in
 *   any folder picked in New agent, so it is never a step left. **Clone**
 *   opens Add project on Clone.
 * - While it is on screen the list reads again every few seconds, so an
 *   install finished in the shell tab ticks its item by itself.
 *
 * `compact` is Home's version: only the steps left, one line each, and a
 * link to Settings → Computers.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api, errText } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { useSetupShell } from '@/lib/setupShell'
import { done, fetchSetup, notThere, ready, setAgentSwitch, shownItems, stepWord, stepsLeft, useAppActions, type SetupAgent, type SetupItem, type SetupReport } from '@/lib/setup'
import { href } from '@/lib/router'
import { Copyable } from './ui'

/** How often an open checklist reads again: an install ticks within this. */
export const SETUP_POLL_MS = 4000

/** The checklist's read, every few seconds while shown. */
export function useSetup(enabled = true, pairKey = '') {
  const got = useApi(() => (enabled ? fetchSetup() : Promise.resolve(undefined)), [enabled], { live: false, intervalMs: enabled ? SETUP_POLL_MS : 0 })
  const { refresh } = got
  // Access from anywhere or a computer arriving: read again at once.
  useEffect(() => { if (pairKey) refresh() }, [pairKey, refresh])
  return got
}

const BUTTON = 'shrink-0 rounded-sm bg-accent px-2.5 py-1 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50'

export function SetupChecklist({ link, pairKey, fallback }: {
  /** The link item's controls (Computers.tsx: Turn on, Show the link). */
  link: ReactNode
  pairKey?: string
  /** Shown when the daemon has no checklist (an older one): the steps it had. */
  fallback: ReactNode
}) {
  const setup = useSetup(true, pairKey)
  // A switch answers with the checklist as it now reads: shown at once,
  // until the next read.
  const [switched, setSwitched] = useState<SetupReport | undefined>(undefined)
  const [switchError, setSwitchError] = useState('')
  useEffect(() => { setSwitched(undefined) }, [setup.data])
  if (setup.error && notThere(setup.error)) return <>{fallback}</>
  const rep = switched ?? setup.data
  if (!rep) {
    return setup.error
      ? <div role="alert" className="text-[12.5px] text-danger">Could not read what this computer needs: {setup.error.message}</div>
      : <div className="text-[12.5px] text-fg-faint">Checking this computer…</div>
  }
  const onSwitch = (id: string, on: boolean) => {
    setSwitchError('')
    setAgentSwitch(id, on).then(setSwitched, (e) => setSwitchError(`Could not switch it: ${errText(e)}`))
  }
  const items = shownItems(rep)
  let n = 0
  return (
    <div className="grid min-w-0 gap-3" data-setup-checklist data-ready={ready(rep) ? 'yes' : 'no'}>
      <ol className="grid min-w-0 gap-3">
        {items.map((it) => (
          <SetupRow key={it.key} n={it.optional ? 0 : ++n} it={it} rep={rep}>
            {it.key === 'link' && !done(it) ? link : null}
            {it.key === 'agent' && rep.agents && rep.agents.length > 0 && <AgentRows rows={rep.agents} os={rep.os} onSwitch={onSwitch} />}
          </SetupRow>
        ))}
      </ol>
      {switchError && <div role="alert" className="text-[12.5px] text-danger">{switchError}</div>}
      {ready(rep)
        ? <div role="status" className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-[13px] text-fg" data-setup-ready>Ready. Start agents from your laptop.</div>
        : <div className="text-[12px] text-fg-faint">This list checks itself every few seconds: finish a step and it ticks.</div>}
    </div>
  )
}

/** One item: a number that becomes a tick (a dashed circle when optional), its label and what to do, and its button. */
function SetupRow({ n, it, rep, children }: { n: number; it: SetupItem; rep: SetupReport; children?: ReactNode }) {
  const ok = done(it)
  const tick = it.optional ? it.state === 'ok' : ok
  const rows = it.key === 'agent' && !!rep.agents?.length
  return (
    <li data-setup-item={it.key} data-state={it.state} data-optional={it.optional ? 'yes' : undefined} className="flex min-w-0 gap-2.5">
      <span
        aria-label={it.optional ? `${it.label}, optional` : ok ? `${it.label}, done` : it.state === 'unknown' ? `${it.label}, not known` : it.label}
        className={`mt-[1px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${it.optional ? (tick ? 'border border-dashed border-ok text-ok' : 'border border-dashed border-[var(--app-hairline-strong)] text-fg-faint') : ok ? 'bg-ok text-panel' : 'bg-panel-2 text-fg-muted'}`}
        data-setup-mark={it.optional ? 'dashed' : undefined}
      >
        {tick ? '✓' : it.optional ? '' : it.state === 'unknown' ? '?' : n}
      </span>
      <div className="grid min-w-0 flex-1 gap-1.5 pt-[2px] text-[13px] text-fg">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1 basis-48">
            <b className="font-medium text-fg">{it.label}</b>
            <span className={`block text-[12.5px] ${ok && !it.optional ? 'text-fg-faint' : 'text-fg-muted'}`}>{it.detail}</span>
          </span>
          {it.key === 'project' ? (it.state !== 'ok' && <ProjectAction />) : !ok && !rows && <ItemAction it={it} rep={rep} />}
        </div>
        {children}
      </div>
    </li>
  )
}

/** Projects here: Clone opens Add project on Clone (the wizard where that is all there is). */
function ProjectAction() {
  const actions = useAppActions()
  const open = actions.cloneProject ?? actions.addProject
  return open ? <button type="button" className={BUTTON} onClick={open}>Clone</button> : null
}

/** The Agents item's rows: a switch each; a switched-on one says its state and its one step. */
function AgentRows({ rows, os, onSwitch }: { rows: SetupAgent[]; os: string; onSwitch: (id: string, on: boolean) => void }) {
  return (
    <ul className="grid min-w-0 gap-1.5 rounded-md border border-[var(--app-hairline)] p-2" aria-label="Agents on this computer">
      {rows.map((a) => (
        <li key={a.id} data-setup-agent={a.id} data-on={a.on ? 'yes' : 'no'} data-state={a.state} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            role="switch"
            aria-checked={a.on}
            aria-label={`${a.label}: ${a.on ? 'on' : 'off'}`}
            onClick={() => onSwitch(a.id, !a.on)}
            className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors ${a.on ? 'bg-accent' : 'bg-panel-2 border border-[var(--app-hairline-strong)]'}`}
          >
            <span aria-hidden="true" className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-panel shadow-sm transition-[left] ${a.on ? 'left-[16px]' : 'left-[2px]'}`} />
          </button>
          <span className={`min-w-0 flex-1 basis-48 ${a.on ? '' : 'text-fg-faint'}`}>
            <span className={a.on ? 'font-medium text-fg' : ''}>{a.on && a.state === 'ok' ? '✓ ' : ''}{a.label}</span>
            {a.on && <span className="block text-[12px] text-fg-muted">{a.detail}</span>}
          </span>
          {a.on && a.command && a.state !== 'ok' && <CommandAction command={a.command} word={stepWord(a.step, a.action)} os={os} />}
        </li>
      ))}
    </ul>
  )
}

/** The one button an item has, or — with no app shell — what to run where. */
function ItemAction({ it, rep }: { it: SetupItem; rep: SetupReport }) {
  const actions = useAppActions()
  if (it.key === 'project') {
    return actions.addProject
      ? <button type="button" className={BUTTON} onClick={actions.addProject}>Add</button>
      : null
  }
  // The link's command is for a terminal over SSH; this screen has its buttons.
  if (!it.command || it.key === 'link') return null
  // The Agents item's command is its first row's step left: named after it.
  const row = it.key === 'agent' ? rep.agents?.find((a) => a.on && a.state !== 'ok' && a.command === it.command) : undefined
  const word = it.key === 'signin' ? 'Sign in' : stepWord(row?.step, it.action)
  return <CommandAction command={it.command} word={word} os={rep.os} />
}

/** A command typed into a shell tab in the home folder; in a browser, shown to copy. */
function CommandAction({ command, word, os }: { command: string; word: string; os: string }) {
  const shell = useSetupShell()
  const home = useApi(() => api.agentCatalog().then((c) => c.home ?? ''), [], { live: false, share: 'setup-home' })
  if (shell) {
    return (
      <button
        type="button"
        className={BUTTON}
        title={`Opens a terminal tab with ${command} typed. You press Enter.`}
        onClick={() => {
          // The home folder: a fresh computer has no project to open the tab in.
          void (home.data !== undefined ? Promise.resolve(home.data) : api.agentCatalog().then((c) => c.home ?? '').catch(() => '')).then((h) => shell(command, h || undefined))
        }}
      >
        {word}
      </button>
    )
  }
  const where = os === 'windows' ? 'PowerShell' : 'a terminal'
  return (
    <span className="grid min-w-0 basis-full gap-1 text-[12px] text-fg-muted">
      <span>Run this in {where} here, then come back:</span>
      <Copyable command={command} className="min-w-0 max-w-full truncate" />
    </span>
  )
}

/**
 * Home's version: shown only on a computer whose role is *Run agents for
 * another computer* and that still misses something; the rest of Home is
 * unchanged. Most people have one computer, so there is no first-run modal.
 * The optional project is never a step left.
 */
export function SetupChecklistCompact() {
  const setup = useSetup(true)
  const rep = setup.data
  if (!rep || ready(rep)) return null
  const left = stepsLeft(rep)
  if (left.length === 0) return null
  return (
    <section data-setup-compact className="grid min-w-0 gap-2 rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-2.5 text-[12.5px]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <b className="text-[13px] font-medium text-fg">Set up this computer to run agents</b>
        <span className="text-fg-muted">{left.length} step{left.length === 1 ? '' : 's'} left</span>
        <a href={href({ name: 'settings', section: 'computers' })} className="ml-auto text-[12px] text-accent hover:underline">Open the checklist</a>
      </div>
      <ul className="grid min-w-0 gap-1.5">
        {left.map((it) => (
          <li key={it.key} data-setup-item={it.key} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 basis-56"><span className="text-fg">{it.label}</span> <span className="text-fg-muted">— {it.detail}</span></span>
            {it.key !== 'link' && <ItemAction it={it} rep={rep} />}
          </li>
        ))}
      </ul>
    </section>
  )
}
