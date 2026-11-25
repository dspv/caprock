/**
 * The parts of a computer's page (`#/m/<id>`) and of its card on All
 * computers (`#/m`): its OS mark, the memory and processor bars, and what is
 * ready there (the owner's pick of 2026-11-25: page B, *Machine card*).
 * Figures come from lib/machinespec.ts; nothing here asks anything.
 */
import type { ReactNode } from 'react'
import { href } from '@/lib/router'
import { agentsReady, cpuPct, gb, machineState, memoryUse, meterWarn, osName, projectsThere, seenAgo, type MachineSpec } from '@/lib/machinespec'
import { nextStep, ready, stepPhrase } from '@/lib/setup'
import type { Machine, MachineSessions } from '@/lib/machines'

/** Windows' four panes, else a laptop: the OS at a glance. */
export function OsGlyph({ os, size = 40 }: { os?: string; size?: number }) {
  if (os === 'windows') {
    return (
      <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden data-os-glyph="windows">
        {[[2, 2], [21, 2], [2, 21], [21, 21]].map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="17" height="17" rx="2" fill="currentColor" />)}
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden data-os-glyph={os ?? 'unknown'}>
      <rect x="4" y="7" width="32" height="21" rx="3" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M14 34h12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/** A thin bar, amber at 70% and over. */
export function MeterBar({ pct, label }: { pct: number; label: string }) {
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-panel-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className={`block h-full rounded-full ${meterWarn(pct) ? 'bg-warn' : 'bg-ok'}`} data-meter-warn={meterWarn(pct) ? '' : undefined} style={{ width: `${pct}%` }} />
    </span>
  )
}

function Meter({ big, sub, children, name }: { big: string; sub: string; children?: ReactNode; name: string }) {
  return (
    <div className="grid gap-1.5" data-machine-meter={name}>
      <div className="flex items-baseline justify-between gap-2">
        <b className="num text-[20px] font-semibold text-fg">{big}</b>
        <span className="text-right text-[12.5px] tabular-nums text-fg-muted">{sub}</span>
      </div>
      {children}
    </div>
  )
}

/** Memory used of total, the processor from the one-minute load, and how many agents run there. */
export function MachineMeters({ spec, running }: { spec?: MachineSpec; running: number }) {
  const f = spec?.machine
  const mem = memoryUse(f)
  const cpu = cpuPct(f)
  const windows = spec?.setup?.os === 'windows'
  return (
    <div className="grid content-start gap-3.5" data-machine-meters>
      {mem ? (
        <Meter name="memory" big={`${mem.used.toFixed(1)} GB`} sub={`used of ${mem.total} GB · ${mem.pct}%`}>
          <MeterBar pct={mem.pct} label="Memory in use" />
        </Meter>
      ) : <Meter name="memory" big="—" sub="memory: no figure from there" />}
      {f ? (
        cpu != null ? (
          <Meter name="cpu" big={`${cpu}%`} sub={`processor, ${f.cpus} cores · load ${f.load1!.toFixed(1)}`}>
            <MeterBar pct={cpu} label="Processor" />
          </Meter>
        ) : <Meter name="cpu" big="No figure" sub={`processor, ${f.cpus} cores · ${windows ? 'Windows gives no load' : 'no load figure'}`} />
      ) : <Meter name="cpu" big="—" sub="processor: no figure from there" />}
      <Meter name="running" big={String(running)} sub={`${running === 1 ? 'agent' : 'agents'} running`} />
    </div>
  )
}

/** What is ready there: each agent ready and signed in, the projects; or the one step left. */
export function MachineReadyList({ m, spec, lastTime }: { m: Pick<Machine, 'name'>; spec?: MachineSpec; lastTime: boolean }) {
  const rep = spec?.setup
  if (!rep) return null
  const agents = agentsReady(rep)
  const projects = projectsThere(rep)
  const next = ready(rep) ? undefined : nextStep(rep)
  return (
    <div className="grid content-start gap-1.5" data-machine-ready-list={ready(rep) ? 'ready' : next?.key ?? ''}>
      <div className="mb-0.5 text-[11.5px] uppercase tracking-[0.04em] text-fg-faint">{lastTime ? 'Ready there, last time' : 'Ready there'}</div>
      {agents.map((a) => (
        <div key={a} className="flex items-center gap-2 text-[13.5px] text-fg"><span aria-hidden className="font-bold text-ok">✓</span>{a}, signed in</div>
      ))}
      {projects != null && (
        <div className="flex items-center gap-2 text-[13.5px] text-fg"><span aria-hidden className="font-bold text-ok">✓</span>{projects === 1 ? '1 project' : `${projects} projects`}</div>
      )}
      {next && (
        <p className="text-[12.5px] text-fg-muted" data-machine-next>
          <b className="font-medium text-fg">{m.name}</b> needs one more step: {stepPhrase(next, rep)}. Open Caprock on it and finish its checklist, or run <span className="mono">caprock setup</span> there over SSH.
        </p>
      )}
    </div>
  )
}

/** One computer on All computers: name, state, memory, cores, running, and the two bars. A click opens its page. */
export function MachineCard({ m, read, spec, now }: { m: Machine; read?: MachineSessions; spec?: MachineSpec; now: number }) {
  const st = machineState(m, read)
  const running = st.down ? 0 : (read?.sessions ?? []).filter((s) => s.status !== 'ended').length
  const f = spec?.machine
  const mem = memoryUse(f)
  const cpu = cpuPct(f)
  const os = spec?.setup?.os
  const state = st.offline ? `offline · ${seenAgo(m.last_seen, now)}` : st.online ? `online${os ? ` · ${osName(os)}` : ''}` : st.down ? 'needs something there' : 'linked'
  return (
    <a
      href={href({ name: 'machine', id: m.id })}
      data-machine-card={m.id}
      data-offline={st.offline ? '' : undefined}
      className={`grid min-w-0 content-start gap-3 rounded-[10px] border border-border bg-panel p-4 text-fg hover:border-border-strong ${st.offline ? 'opacity-75' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-border-strong bg-bg text-fg-muted"><OsGlyph os={os} size={17} /></span>
        <span className="min-w-0">
          <b className="block truncate text-[17px] font-semibold">{m.name}</b>
          <small className={`block text-[12px] ${st.online ? 'text-ok' : 'text-fg-faint'}`} data-machine-card-state>{state}</small>
        </span>
      </span>
      <span className="flex gap-4 text-[12px] tabular-nums text-fg-muted">
        <span><b className="num block text-[18px] font-semibold text-fg">{f?.mem_total ? `${gb(f.mem_total)} GB` : '—'}</b>memory</span>
        <span><b className="num block text-[18px] font-semibold text-fg">{f?.cpus ?? '—'}</b>cores</span>
        <span><b className="num block text-[18px] font-semibold text-fg">{st.offline ? '–' : running}</b>running</span>
      </span>
      {st.offline || !f ? (
        m.version && <span className="text-[12px] text-fg-faint">Caprock {m.version}</span>
      ) : (
        <span className="grid gap-1.5 text-[11.5px] tabular-nums text-fg-faint">
          <span className="grid grid-cols-[52px_minmax(0,1fr)_38px] items-center gap-2">
            <span>Memory</span>{mem ? <><MeterBar pct={mem.pct} label="Memory in use" /><span className="text-right">{mem.pct}%</span></> : <><span>no figure</span><span /></>}
          </span>
          <span className="grid grid-cols-[52px_minmax(0,1fr)_38px] items-center gap-2" data-machine-card-cpu>
            <span>CPU</span>{cpu != null ? <><MeterBar pct={cpu} label="Processor" /><span className="text-right">{cpu}%</span></> : <><span>{os === 'windows' ? 'no figure on Windows' : 'no figure'}</span><span /></>}
          </span>
        </span>
      )}
    </a>
  )
}
