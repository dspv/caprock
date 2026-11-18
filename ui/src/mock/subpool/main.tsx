/**
 * MOCKUP ONLY — subscription pool: an "Auto" subscription choice and one
 * overview of every sign-in's limits. Two variants of each, on example data
 * (./data.ts). Not part of the dashboard build: /mock-subpool.html in `vite`
 * dev. `?frame=<id>` renders one frame alone, for screenshots.
 */
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '@/design/tokens.css'
import { AgentCharacter } from '@/components/Characters'
import { Ring } from '@/components/Donut'
import { LIMIT_ACTION, SUBS, autoPick, binding, leftOf, usd, type Agent, type Sub, type Win } from './data'

// ---------------------------------------------------------------- pieces

function Example() {
  return (
    <span className="inline-flex items-center rounded-full border border-warn/60 px-2 py-[1px] text-[10.5px] font-medium uppercase tracking-[0.08em] text-warn">
      Example data
    </span>
  )
}

function tone(used: number): string {
  return used > 85 ? 'var(--color-danger)' : used >= 60 ? 'var(--color-warn)' : 'var(--color-ok)'
}
function toneText(used: number): string {
  return used > 85 ? 'text-danger' : used >= 60 ? 'text-warn' : 'text-fg'
}

/** A thin used-share bar; grey when the reading says nothing about now. */
function Bar({ w, width = "w-full", left }: { w?: Win; width?: string; left?: boolean }) {
  const used = w ? (w.passed ? 0 : w.used) : 0
  return (
    <span className={`relative block h-[5px] ${width} overflow-hidden rounded-full bg-panel-2`}>
      {w && !w.passed && <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${left ? 100 - used : used}%`, background: tone(used) }} />}
      {w?.passed && <span className="absolute inset-0 rounded-full border border-dashed border-fg-faint/60" />}
    </span>
  )
}

function who(agent: Agent) {
  return agent === 'claude' ? 'lead' : 'codex'
}

function agentName(agent: Agent) {
  return agent === 'claude' ? 'Claude Code' : 'Codex'
}

/** "Work — 62% of its 5-hour limit left" */
function reason(s: Sub): string {
  const b = binding(s)
  if (!b) return `${s.label} · no limit figures yet`
  if (b.w.passed) return `${s.label} · its ${b.name} window reopened at ${b.w.resets}`
  return `${s.label} · ${b.left}% of its ${b.name} limit left`
}

function Frame({ id, title, sub, children, width }: { id: string; title: string; sub: string; children: ReactNode; width?: string }) {
  return (
    <section data-frame={id} className={`grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 ${width ?? ''}`}>
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          <Example />
        </div>
        <p className="max-w-[70ch] text-[12.5px] leading-snug text-fg-muted">{sub}</p>
      </header>
      {children}
    </section>
  )
}

/** The New agent sheet around a picker, as the dialog draws it. */
function NewAgentSheet({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-[560px] rounded-[10px] border border-border-strong bg-panel shadow-[var(--shadow-panel)]">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-[14px] font-medium">New agent</h3>
        <span className="text-[12px] text-fg-faint">Esc</span>
      </div>
      <div className="grid gap-3 px-4 py-4">
        <label className="grid gap-1">
          <span className="text-[11px] text-fg-muted">Folder</span>
          <span className="input">~/dev/caprock</span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">
            <span className="text-[11px] text-fg-muted">Agent</span>
            <span className="input">Claude Code</span>
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] text-fg-muted">Model</span>
            <span className="input">Default</span>
          </label>
        </div>
        {children}
        <label className="grid gap-1">
          <span className="text-[11px] text-fg-muted">First message</span>
          <span className="input h-[54px] text-fg-faint">What should it do?</span>
        </label>
        <div className="flex justify-end gap-2">
          <span className="rounded-[4px] border border-border-strong px-3 py-1 text-[12.5px] text-fg-muted">Cancel</span>
          <span className="rounded-[4px] bg-accent px-3 py-1 text-[12.5px] font-medium text-bg">Start</span>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------- Auto picker, variant 1

/** V1: "Auto" is the select's first option; one line under it says what it picked and why. */
function PickerV1({ open }: { open?: boolean }) {
  const pick = autoPick('claude')!
  const b = binding(pick)!
  const list = SUBS.filter((s) => s.agent === 'claude')
  return (
    <div className="grid gap-1.5">
      <label className="grid min-w-0 gap-1">
        <span className="text-[11px] text-fg-muted">Subscription</span>
        <span className="input flex items-center justify-between">
          <span className="truncate">Auto · now {pick.label}</span>
          <span className="text-fg-faint">▾</span>
        </span>
      </label>
      {open && (
        <ul className="grid overflow-hidden rounded-[4px] border border-border-strong bg-panel-2 font-mono text-[12px]">
          <li className="bg-accent/15 px-2 py-1 text-fg">✓ Auto · the one with the most room when it starts</li>
          {list.map((s) => {
            const bb = binding(s)
            return (
              <li key={s.id} className="flex justify-between gap-3 px-2 py-1 text-fg">
                <span className="truncate">{s.label}{s.preferred ? ' (default)' : ''}</span>
                <span className="shrink-0 text-fg-muted">
                  {!s.signedIn ? 'not signed in' : bb ? (bb.w.passed ? `${bb.name} reopened` : `${100 - bb.left}% ${bb.name}`) : 'no figures yet'}
                </span>
              </li>
            )
          })}
          <li className="border-t border-border px-2 py-1 text-fg-muted">Add subscription…</li>
        </ul>
      )}
      <p role="note" className="text-[12px] leading-snug text-fg-muted">
        <span className="text-fg">Auto picked {pick.label}:</span> {b.left}% of its {b.name} limit left, resets {b.w.resets}
        <span className="text-fg-faint"> · figures from {pick.seen}</span>. Personal is at 88% of its 5-hour.{' '}
        <span className="text-accent underline-offset-2 hover:underline">Pick myself</span>
      </p>
    </div>
  )
}

// ------------------------------------------------- Auto picker, variant 2

function HeadroomRow({ s, picked, auto }: { s: Sub; picked?: boolean; auto?: boolean }) {
  const off = !s.signedIn
  return (
    <li className={`grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2 px-3 py-2 ${picked ? 'bg-accent/10' : ''} ${off ? 'opacity-60' : ''}`}>
      <span className={`mt-[3px] grid h-3.5 w-3.5 place-items-center rounded-full border ${picked ? 'border-accent' : 'border-border-strong'}`}>
        {picked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="grid min-w-0 gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] text-fg">{s.label}</span>
          {s.preferred && <span className="text-[11px] text-fg-faint">default</span>}
          {auto && <span className="rounded-full bg-accent/20 px-1.5 text-[10.5px] text-accent">Auto's pick</span>}
          <span className="ml-auto shrink-0 text-[11px] text-fg-faint">{s.signedIn ? s.seen : 'not signed in'}</span>
        </span>
        {s.signedIn && (
          <span className="grid grid-cols-2 gap-3 text-[11px] text-fg-muted">
            <span className="grid gap-0.5">
              <Bar w={s.five} left />
              <span className="flex justify-between gap-1"><span>5 h</span><span className="num">{s.five ? (s.five.passed ? 'reopened' : `${leftOf(s.five)}% left`) : '—'}</span></span>
            </span>
            <span className="grid gap-0.5">
              <Bar w={s.week} left />
              <span className="flex justify-between gap-1"><span>Week</span><span className="num">{s.week ? `${leftOf(s.week)}% left` : '—'}</span></span>
            </span>
          </span>
        )}
      </span>
    </li>
  )
}

/** V2: a short list of the sign-ins with their room, Auto on top. */
function PickerV2() {
  const pick = autoPick('claude')!
  const list = SUBS.filter((s) => s.agent === 'claude')
  return (
    <div className="grid gap-1">
      <span className="text-[11px] text-fg-muted">Runs on</span>
      <ul className="overflow-hidden rounded-[6px] border border-border-strong bg-panel-2 [&>li+li]:border-t [&>li+li]:border-border">
        <li className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2 px-3 py-2">
          <span className="mt-[3px] grid h-3.5 w-3.5 place-items-center rounded-full border border-accent"><span className="h-2 w-2 rounded-full bg-accent" /></span>
          <span className="grid gap-0.5">
            <span className="text-[13px] text-fg">Auto <span className="text-fg-muted">— {reason(pick)}</span></span>
            <span className="text-[11px] text-fg-faint">Picked from the figures below when the session starts. A running session never moves.</span>
          </span>
        </li>
        {list.map((s) => <HeadroomRow key={s.id} s={s} auto={s === pick} />)}
      </ul>
    </div>
  )
}

// --------------------------------------------------------- phone New chat

function PhoneSheet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[390px] rounded-t-[16px] border border-border bg-panel px-4 pb-6 pt-3">
      <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-border-strong" />
      <h3 className="mb-3 text-[17px] font-semibold">{title}</h3>
      <ol className="mb-3 flex items-center gap-2 text-[12.5px] text-fg-faint">
        {['Who works', 'Where', 'Chat'].map((s, i) => (
          <li key={s} className={`flex items-center gap-1.5 ${i === 0 ? 'font-medium text-fg' : ''}`}>
            <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${i === 0 ? 'bg-accent text-bg' : 'border border-border-strong'}`}>{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      {children}
      <p className="mt-3 px-1 text-[13px] text-fg-muted">Add subscription — on your Mac: Settings → Subscriptions</p>
    </div>
  )
}

function WhoRow({ agent, label, hint, last, accent }: { agent: Agent; label: string; hint?: ReactNode; last?: boolean; accent?: boolean }) {
  return (
    <li className="border-b border-border last:border-b-0">
      <div className={`flex min-h-[60px] w-full min-w-0 items-center gap-3 px-3 ${accent ? 'bg-accent/10' : ''}`}>
        <AgentCharacter who={who(agent)} size={34} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-medium text-fg">{label}</span>
          {hint && <span className="block truncate text-[13px] text-fg-muted">{hint}</span>}
        </span>
        {last && <span className="shrink-0 text-[12px] text-accent">last used</span>}
        <span className="shrink-0 text-fg-faint">›</span>
      </div>
    </li>
  )
}

/** Phone V1: "Claude · Auto" and "Codex · Auto" rows above the sign-ins. */
function PhoneV1() {
  const c = autoPick('claude')!
  const claude = SUBS.filter((s) => s.agent === 'claude' && s.signedIn)
  return (
    <PhoneSheet title="Who works">
      <ul className="overflow-hidden rounded-[12px] border border-border bg-bg">
        <WhoRow agent="claude" label="Claude · Auto" hint={`${c.label} now · ${binding(c)!.left}% of ${binding(c)!.name} left`} last accent />
        {claude.map((s) => {
          const b = binding(s)
          return <WhoRow key={s.id} agent="claude" label={`Claude · ${s.label}`} hint={b ? (b.w.passed ? `${b.name} reopened · ${s.plan}` : `${b.left}% of ${b.name} left · ${s.plan}`) : s.plan} />
        })}
        <WhoRow agent="codex" label="Codex" hint="Your ChatGPT sign-in · 36% of weekly left" />
      </ul>
    </PhoneSheet>
  )
}

/** Phone V2: one row per agent, Auto by default; the sign-ins with their bars fold out under it. */
function PhoneV2() {
  const c = autoPick('claude')!
  const claude = SUBS.filter((s) => s.agent === 'claude')
  return (
    <PhoneSheet title="Who works">
      <ul className="overflow-hidden rounded-[12px] border border-border bg-bg">
        <li className="border-b border-border">
          <div className="flex min-h-[60px] items-center gap-3 bg-accent/10 px-3">
            <AgentCharacter who="lead" size={34} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[16px] font-medium">Claude</span>
              <span className="block truncate text-[13px] text-fg-muted">Auto · now {c.label}</span>
            </span>
            <span className="shrink-0 rounded-full border border-border-strong px-2 py-0.5 text-[12px] text-fg-muted">Runs on ▴</span>
          </div>
          <ul className="border-t border-border bg-panel [&>li+li]:border-t [&>li+li]:border-border">
            <li className="flex min-h-[44px] items-center gap-2 px-3 text-[14px]">
              <span className="grid h-4 w-4 place-items-center rounded-full border border-accent"><span className="h-2 w-2 rounded-full bg-accent" /></span>
              <span className="min-w-0 flex-1 truncate">Auto <span className="text-fg-muted">— {reason(c)}</span></span>
            </li>
            {claude.map((s) => <HeadroomRow key={s.id} s={s} auto={s === c} />)}
          </ul>
        </li>
        <WhoRow agent="codex" label="Codex" hint="Your ChatGPT sign-in · 36% of weekly left" />
      </ul>
    </PhoneSheet>
  )
}

// ------------------------------------------------ overview, variant 1

function WinCell({ w, label }: { w?: Win; label: string }) {
  if (!w) return <span className="text-[12px] text-fg-faint">{label}: not reported</span>
  return (
    <span className="grid min-w-0 gap-1">
      <span className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-fg-muted">{label}</span>
        {w.passed
          ? <span className="text-fg-faint" title="Its reset has passed since this sign-in last reported: the window has reopened, and how much is used now is unknown">reopened {w.resets}</span>
          : <span className={`num font-mono ${toneText(w.used)}`}>{Math.round(w.used)}%</span>}
      </span>
      <Bar w={w} />
      <span className="truncate text-[11px] text-fg-faint">{w.passed ? 'last reading before the reset' : `resets ${w.resets} · ${w.inText}`}</span>
    </span>
  )
}

function OnLimit({ s }: { s: Sub }) {
  if (LIMIT_ACTION !== 'auto') return <span className="text-fg-faint">Ask me</span>
  if (s.own && s.agent === 'claude') return <span className="text-fg-faint">moves from here</span>
  if (!s.signedIn) return <span className="text-fg-faint">—</span>
  if (s.autoOrder === undefined) return <span className="text-fg-faint">not in the order</span>
  return <span className="text-fg">#{s.autoOrder} <span className="text-fg-faint">· {s.carry}</span></span>
}

function OverviewRow({ s }: { s: Sub }) {
  return (
    <li className="grid gap-x-5 gap-y-2 px-3 py-2.5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] md:items-center">
      <span className="flex min-w-0 items-center gap-2.5">
        <AgentCharacter who={who(s.agent)} size={26} />
        <span className="grid min-w-0">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] font-medium">{s.label}</span>
            {s.plan && <span className="text-[11px] text-fg-muted">{s.plan}</span>}
            {s.preferred && <span className="text-[10.5px] text-fg-faint">default</span>}
          </span>
          <span className="truncate text-[11px] text-fg-faint">{s.signedIn ? `${s.account} · as of ${s.seen}` : 'not signed in — Sign in'}</span>
        </span>
      </span>
      {s.signedIn ? (
        <>
          <WinCell w={s.five} label="5 hours" />
          <WinCell w={s.week} label="Week" />
          <span className="grid text-[12px] md:text-right">
            <span className="num font-mono">{usd(s.cost7d)} <span className="text-fg-faint">at API</span></span>
            <span className="text-[11px] text-fg-faint">{s.sessions7d} sessions · 7 days</span>
          </span>
          <span className="grid text-[12px] md:text-right">
            <span>{s.running > 0 ? <span className="text-ok">● {s.running} running</span> : <span className="text-fg-faint">none running</span>}</span>
            <span className="text-[11px]"><span className="text-fg-faint">on a limit: </span><OnLimit s={s} /></span>
          </span>
        </>
      ) : <span className="text-[12px] text-fg-faint md:col-span-4">No figures until it is signed in and a session runs on it.</span>}
    </li>
  )
}

/** Overview V1: Now's Plan limits panel grows one row per sign-in. */
function OverviewV1() {
  const groups: Agent[] = ['claude', 'codex']
  return (
    <section className="rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]">
      <header className="flex flex-wrap items-center justify-between gap-2 rounded-t-[var(--radius-panel)] border-b border-border bg-panel-2/60 px-3 py-2">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">▾ Plan limits · 5 sign-ins</h2>
        <span className="text-[11px] text-fg-faint">On a limit: continue automatically (Settings)</span>
      </header>
      {groups.map((g) => {
        const list = SUBS.filter((s) => s.agent === g)
        const pick = autoPick(g)
        return (
          <div key={g}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-3 pb-1 pt-2.5">
              <span className="text-[11px] uppercase tracking-[0.1em] text-fg-muted">{agentName(g)}</span>
              {pick && list.length > 1 && <span className="text-[11.5px] text-fg-muted">Auto would start on <span className="text-fg">{pick.label}</span> now</span>}
            </div>
            <ul className="[&>li+li]:border-t [&>li+li]:border-border">{list.map((s) => <OverviewRow key={g + s.id} s={s} />)}</ul>
          </div>
        )
      })}
      <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-fg-faint">
        Each sign-in's figures arrive only while a session runs on it: Claude Code's status line, Codex's own log. Use elsewhere — claude.ai, another computer — draws on the same limits unseen. Spend is at API list price, not your bill.
      </p>
    </section>
  )
}

// ------------------------------------------------ overview, variant 2

function RingCell({ w, label }: { w?: Win; label: string }) {
  const used = w && !w.passed ? w.used : 0
  return (
    <span className="grid justify-items-center gap-1 text-center">
      <Ring value={used / 100} size={64} width={6} color={tone(used)} dim={!w || w.passed}>
        <span className={`num font-mono text-[14px] ${w && !w.passed ? toneText(used) : 'text-fg-faint'}`}>{w ? (w.passed ? '—' : `${Math.round(w.used)}%`) : '—'}</span>
      </Ring>
      <span className="text-[11.5px] text-fg-muted">{label}</span>
      <span className="text-[10.5px] leading-tight text-fg-faint">{!w ? 'not reported' : w.passed ? `reopened ${w.resets}` : `resets ${w.resets}`}</span>
    </span>
  )
}

function SubCard({ s, pick }: { s: Sub; pick?: boolean }) {
  return (
    <article className={`grid content-start gap-3 rounded-[8px] border bg-panel p-3 shadow-[var(--shadow-panel)] ${pick ? 'border-accent/60' : 'border-border'}`}>
      <header className="flex items-start gap-2">
        <AgentCharacter who={who(s.agent)} size={30} />
        <span className="grid min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[14px] font-medium">{s.label}</span>
            <span className="text-[11px] text-fg-muted">{s.plan ?? ''}</span>
          </span>
          <span className="truncate text-[11px] text-fg-faint">{s.signedIn ? s.account : 'not signed in'}</span>
        </span>
        {pick && <span className="shrink-0 rounded-full bg-accent/20 px-2 text-[10.5px] text-accent">Auto now</span>}
      </header>
      {s.signedIn ? (
        <>
          <div className="grid grid-cols-2">
            <RingCell w={s.five} label="5 hours" />
            <RingCell w={s.week} label="Week" />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-[11.5px]">
            <dt className="text-fg-faint">7 days</dt><dd className="num text-right font-mono">{usd(s.cost7d)} · {s.sessions7d} sess.</dd>
            <dt className="text-fg-faint">Running</dt><dd className="text-right">{s.running > 0 ? <span className="text-ok">{s.running}</span> : '0'}</dd>
            <dt className="text-fg-faint">On a limit</dt><dd className="truncate text-right"><OnLimit s={s} /></dd>
            <dt className="text-fg-faint">As of</dt><dd className="text-right text-fg-muted">{s.seen}</dd>
          </dl>
        </>
      ) : (
        <p className="text-[12px] text-fg-muted">No figures until it is signed in. <span className="text-accent">Sign in</span></p>
      )}
    </article>
  )
}

/** Overview V2: Settings → Subscriptions as a card per sign-in. */
function OverviewV2() {
  return (
    <div className="grid gap-4 rounded-[var(--radius-panel)] border border-border bg-bg p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Settings · Subscriptions</h2>
        <span className="text-[12px] text-fg-muted">On a limit: continue automatically · <span className="text-accent">change</span></span>
      </div>
      {(['claude', 'codex'] as Agent[]).map((g) => {
        const pick = autoPick(g)
        const list = SUBS.filter((s) => s.agent === g)
        return (
          <div key={g} className="grid gap-2">
            <h3 className="text-[11px] uppercase tracking-[0.1em] text-fg-muted">{agentName(g)}</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {list.map((s) => <SubCard key={g + s.id} s={s} pick={list.length > 1 && s === pick} />)}
              {g === 'codex' && (
                <div className="grid place-items-center rounded-[8px] border border-dashed border-border-strong p-3 text-[12.5px] text-fg-muted">+ Add Codex subscription</div>
              )}
            </div>
          </div>
        )
      })}
      <p className="text-[11px] leading-snug text-fg-faint">
        Figures arrive only while a session runs on a sign-in, so an idle one shows its last reading and when that was. Spend is at API list price, not your bill.
      </p>
    </div>
  )
}

// -------------------------------------------------------------- the page

const FRAMES: Record<string, { title: string; sub: string; node: ReactNode }> = {
  'picker-v1': {
    title: 'Auto picker — V1: an option in the existing select',
    sub: 'Auto is the first option of the Subscription select in New agent and Quick chat; one line under it names the pick and the reason. The list is shown open beside the closed state.',
    node: (
      <div className="flex flex-wrap items-start gap-6">
        <NewAgentSheet><PickerV1 /></NewAgentSheet>
        <div className="w-full max-w-[360px]"><PickerV1 open /></div>
      </div>
    ),
  },
  'picker-v2': {
    title: 'Auto picker — V2: a "Runs on" list with each sign-in\'s room',
    sub: 'The select becomes a short radio list: Auto on top with its reason, then each sign-in with 5-hour and weekly bars and how fresh the figures are.',
    node: <NewAgentSheet><PickerV2 /></NewAgentSheet>,
  },
  'phone-v1': {
    title: 'Phone New chat — V1',
    sub: '"Claude · Auto" is the first Who works row; each sign-in row says how much of its tightest window is left.',
    node: <PhoneV1 />,
  },
  'phone-v2': {
    title: 'Phone New chat — V2',
    sub: 'One Claude row starting on Auto; "Runs on" folds out the sign-ins with their bars.',
    node: <PhoneV2 />,
  },
  'overview-v1': {
    title: 'Overview — V1: Plan limits panel on Now and Cost, one row per sign-in',
    sub: 'The panel that already answers "can I keep going" lists every sign-in: both windows, reset, freshness, 7-day spend, running sessions, and its place in the switch-on-limit order.',
    node: <OverviewV1 />,
  },
  'overview-v2': {
    title: 'Overview — V2: Settings → Subscriptions as cards',
    sub: 'Each sign-in is a card with two rings (the Plan limits gauges), 7-day spend, running, on-a-limit place and freshness; management actions stay on the card.',
    node: <OverviewV2 />,
  },
}

function Page() {
  const frame = new URLSearchParams(location.search).get('frame')
  const ids = frame && FRAMES[frame] ? [frame] : Object.keys(FRAMES)
  return (
    <main className="mx-auto grid grid-cols-[minmax(0,1fr)] max-w-[1180px] gap-10 px-4 py-6">
      {!frame && (
        <header className="grid gap-1">
          <h1 className="text-[20px] font-semibold">Subscription pool — mockups</h1>
          <p className="text-[13px] text-fg-muted">Two variants each of the Auto subscription choice and the all-subscriptions overview. Every figure is example data.</p>
        </header>
      )}
      {ids.map((id) => {
        const f = FRAMES[id]!
        return <Frame key={id} id={id} title={f.title} sub={f.sub}>{f.node}</Frame>
      })}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Page /></StrictMode>)
