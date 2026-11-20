/**
 * The setup checklist on the computer that runs agents (ADR-099): what it
 * needs before agents can run here and be started from the laptop, read from
 * `GET /v1/setup` — Git, Claude Code or Codex, its sign-in, a project, and the
 * link — each with the one button that does it.
 *
 * - **Install / Sign in** open a shell tab with the command typed, not run:
 *   the user reads it and presses Enter (ADR-046; the owner accepted it for
 *   this, 2026-11-20, translated: "if it is really needed, ok"). In a browser,
 *   where there are no tabs, the command is shown to copy with where to run it.
 * - **A project** opens the app's Add project (clone or pick a folder).
 * - **Link to your laptop** holds Turn on and Show the link (`link`).
 * - While it is on screen the list reads again every few seconds, so an
 *   install finished in the shell tab ticks its item by itself.
 *
 * `compact` is Home's version: only what is left, one line each, and a link
 * to Settings → Computers.
 */
import { useEffect, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { useSetupShell } from '@/lib/setupShell'
import { done, fetchSetup, notThere, ready, shownItems, useAppActions, type SetupItem, type SetupReport } from '@/lib/setup'
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
  if (setup.error && notThere(setup.error)) return <>{fallback}</>
  const rep = setup.data
  if (!rep) {
    return setup.error
      ? <div role="alert" className="text-[12.5px] text-danger">Could not read what this computer needs: {setup.error.message}</div>
      : <div className="text-[12.5px] text-fg-faint">Checking this computer…</div>
  }
  const items = shownItems(rep)
  return (
    <div className="grid min-w-0 gap-3" data-setup-checklist data-ready={ready(rep) ? 'yes' : 'no'}>
      <ol className="grid min-w-0 gap-3">
        {items.map((it, i) => (
          <SetupRow key={it.key} n={i + 1} it={it} rep={rep}>
            {it.key === 'link' && !done(it) ? link : null}
          </SetupRow>
        ))}
      </ol>
      {ready(rep)
        ? <div role="status" className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-[13px] text-fg" data-setup-ready>Ready. Start agents from your laptop.</div>
        : <div className="text-[12px] text-fg-faint">This list checks itself every few seconds: finish a step and it ticks.</div>}
    </div>
  )
}

/** One item: a number that becomes a tick, its label and what to do, and its button. */
function SetupRow({ n, it, rep, children }: { n: number; it: SetupItem; rep: SetupReport; children?: ReactNode }) {
  const ok = done(it)
  return (
    <li data-setup-item={it.key} data-state={it.state} className="flex min-w-0 gap-2.5">
      <span
        aria-label={ok ? `${it.label}, done` : it.state === 'unknown' ? `${it.label}, not known` : it.label}
        className={`mt-[1px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${ok ? 'bg-ok text-panel' : 'bg-panel-2 text-fg-muted'}`}
      >
        {ok ? '✓' : it.state === 'unknown' ? '?' : n}
      </span>
      <div className="grid min-w-0 flex-1 gap-1.5 pt-[2px] text-[13px] text-fg">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1 basis-48">
            <b className="font-medium text-fg">{it.label}</b>
            <span className={`block text-[12.5px] ${ok ? 'text-fg-faint' : 'text-fg-muted'}`}>{it.detail}</span>
          </span>
          {!ok && <ItemAction it={it} rep={rep} />}
        </div>
        {children}
      </div>
    </li>
  )
}

/** The one button an item has, or — with no app shell — what to run where. */
function ItemAction({ it, rep }: { it: SetupItem; rep: SetupReport }) {
  const shell = useSetupShell()
  const actions = useAppActions()
  const home = useApi(() => api.agentCatalog().then((c) => c.home ?? ''), [], { live: false, share: 'setup-home' })
  if (it.key === 'project') {
    return actions.addProject
      ? <button type="button" className={BUTTON} onClick={actions.addProject}>Add</button>
      : null
  }
  // The link's command is for a terminal over SSH; this screen has its buttons.
  if (!it.command || it.key === 'link') return null
  const word = it.key === 'signin' ? 'Sign in' : 'Install'
  if (shell) {
    return (
      <button
        type="button"
        className={BUTTON}
        title={`Opens a terminal tab with ${it.command} typed. You press Enter.`}
        onClick={() => {
          // The home folder: a fresh computer has no project to open the tab in.
          void (home.data !== undefined ? Promise.resolve(home.data) : api.agentCatalog().then((c) => c.home ?? '').catch(() => '')).then((h) => shell(it.command!, h || undefined))
        }}
      >
        {word}
      </button>
    )
  }
  const where = rep.os === 'windows' ? 'PowerShell' : 'a terminal'
  return (
    <span className="grid min-w-0 basis-full gap-1 text-[12px] text-fg-muted">
      <span>Run this in {where} here, then come back:</span>
      <Copyable command={it.command} className="min-w-0 max-w-full truncate" />
    </span>
  )
}

/**
 * Home's version: shown only on a computer whose role is *Run agents for
 * another computer* and that still misses something; the rest of Home is
 * unchanged. Most people have one computer, so there is no first-run modal.
 */
export function SetupChecklistCompact() {
  const setup = useSetup(true)
  const rep = setup.data
  if (!rep || ready(rep)) return null
  const left = shownItems(rep).filter((it) => !done(it))
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
