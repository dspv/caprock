/**
 * Whether a linked computer is ready to run agents, read from it (ADR-099):
 * its `GET /v1/setup` and `GET /v1/resources` through `/v1/m/<id>/…`. Chips
 * for what it has — online, Claude Code / Codex, signed in, N projects, its
 * OS and memory — and **Start an agent there**; or, when something is left,
 * the one next step and where to finish it (its own screen, or `caprock
 * setup` over SSH).
 *
 * After the owner's first two-computer test (2026-11-20) the laptop showed
 * the PC linked and said nothing about whether it could do anything. A
 * computer running a Caprock from before the checklist answers 404: nothing
 * is drawn and nothing breaks.
 */
import { machineBase, type Machine } from '@/lib/machines'
import { useApi } from '@/lib/useApi'
import { done, fetchSetup, item, nextStep, ready, stepPhrase, useAppActions } from '@/lib/setup'
import { href } from '@/lib/router'
import type { ResourceReport } from '@/lib/resources'

function osName(os: string): string {
  return os === 'darwin' ? 'macOS' : os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : os
}

async function machineResources(id: string): Promise<ResourceReport | undefined> {
  try {
    const res = await fetch(`${machineBase(id)}/v1/resources`, { headers: { Accept: 'application/json' } })
    return res.ok ? ((await res.json()) as ResourceReport) : undefined
  } catch { return undefined }
}

/** "2 projects." → 2; the daemon words the count (internal/readiness). */
export function projectCount(detail: string): number {
  const m = /^(\d+) project/.exec(detail)
  return m ? Number(m[1]) : 0
}

const CHIP = 'shrink-0 rounded-[4px] border border-[var(--app-hairline-strong)] px-1.5 py-px text-[11px] text-fg-muted'

export function MachineReadiness({ m, intervalMs = 30_000 }: { m: Pick<Machine, 'id' | 'name' | 'status'>; intervalMs?: number }) {
  const setup = useApi(() => fetchSetup(machineBase(m.id)), [m.id], { live: false, intervalMs })
  const res = useApi(() => machineResources(m.id), [m.id], { live: false, intervalMs: intervalMs * 4 })
  const actions = useAppActions()
  const rep = setup.data
  // An older Caprock there (404), or not answering: say nothing new.
  if (!rep) return null
  const agent = item(rep, 'agent')
  const signin = item(rep, 'signin')
  const projects = item(rep, 'project')
  const mem = res.data?.machine?.mem_total
  const chips: string[] = []
  if (m.status === 'online') chips.push('online')
  if (done(agent)) chips.push(agent!.label)
  if (done(signin)) chips.push('signed in')
  if (done(projects)) {
    const n = projectCount(projects!.detail)
    chips.push(n === 1 ? '1 project' : `${n} projects`)
  }
  chips.push(mem ? `${osName(rep.os)} · ${Math.round(mem / 2 ** 30)} GB` : osName(rep.os))
  const next = nextStep(rep)
  const ok = ready(rep)
  return (
    <span className="mt-1 grid min-w-0 gap-1.5" data-machine-readiness={ok ? 'ready' : next?.key}>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {ok && <span className="shrink-0 rounded-[4px] bg-ok/15 px-1.5 py-px text-[11px] font-medium text-ok">ready</span>}
        {chips.map((c) => <span key={c} className={CHIP}>{c}</span>)}
      </span>
      {ok ? (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {actions.newAgentOn
            ? <button type="button" onClick={() => actions.newAgentOn!(m.id)} className="rounded-sm bg-accent px-2.5 py-1 text-[12.5px] font-medium text-panel hover:brightness-110" data-start-there>Start an agent there</button>
            : <a href={href({ name: 'machine', id: m.id })} className="text-[12.5px] text-accent hover:underline" data-start-there>Open {m.name} to start an agent there</a>}
        </span>
      ) : next && (
        <span className="text-[12.5px] text-fg-muted" data-machine-next>
          <b className="font-medium text-fg">{m.name}</b> needs one more step: {stepPhrase(next)}. Open Caprock on it and finish its checklist, or run <span className="mono">caprock setup</span> there over SSH.
        </span>
      )}
    </span>
  )
}
