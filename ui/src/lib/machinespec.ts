/**
 * What another computer is and how loaded it is, for its sidebar row, its
 * page (`#/m/<id>`) and its card on All computers (`#/m`): read from what it
 * already answers through `/v1/m/<id>/…`, nothing new collected.
 *
 * - **Its setup check**, `GET /v1/setup` (ADR-099): the OS, the agents ready
 *   there, sign-in, and how many projects.
 * - **Its resource report**, `GET /v1/resources`: `machine` — cores, the
 *   one-minute load (absent on Windows, which gives none), physical memory
 *   and what is free to take.
 *
 * Both are asked together, shared by every view of the same computer
 * (`useApi`'s share key), and the last answer is kept in this browser
 * (lib/swr.ts) so an offline computer still shows what it was last time,
 * said as last time. A computer whose Caprock predates either route answers
 * 404 for it: that half is simply absent.
 */
import { machineBase, type Machine, type MachineSessions } from './machines'
import { done, item, readyAgents, type SetupReport } from './setup'
import type { ResourceReport } from './resources'
import { useApi, type Loaded } from './useApi'
import { fmtAgo } from './format'

export type MachineFigures = NonNullable<ResourceReport['machine']>

/** The two answers, as they are kept. */
export interface MachineSpec {
  setup?: SetupReport
  machine?: MachineFigures
}

async function getJSON<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    return res.ok ? ((await res.json()) as T) : undefined
  } catch { return undefined }
}

/** Both reads at once; neither answering is an error, so the last answer stays on screen. */
export async function fetchMachineSpec(id: string): Promise<MachineSpec> {
  const base = machineBase(id)
  const [setup, res] = await Promise.all([getJSON<SetupReport>(`${base}/v1/setup`), getJSON<ResourceReport>(`${base}/v1/resources`)])
  if (!setup && !res?.machine) throw new Error('no answer')
  // Only what is drawn is kept: the resource report's sessions and processes are about now.
  return { ...(setup ? { setup } : {}), ...(res?.machine ? { machine: res.machine } : {}) }
}

/**
 * A computer's spec, re-read every `intervalMs` while `active` (a computer
 * that answered offline is not asked again until it is back). Every view of
 * one computer shares one request.
 */
export function useMachineSpec(id: string, active: boolean, intervalMs = 60_000): Loaded<MachineSpec> {
  // A computer known to be down is not asked at all, its first read included:
  // the kept answer stands, and the read comes when it is back.
  return useApi(() => (active ? fetchMachineSpec(id) : Promise.reject(new Error('down'))), [id], { live: false, intervalMs, active, cache: `machine-spec:${id}`, keepUnchanged: true })
}

export function osName(os: string | undefined): string {
  return os === 'darwin' ? 'macOS' : os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : os ?? ''
}

/** Whole gigabytes, as the setup chips say them (*Windows · 32 GB*). */
export function gb(bytes: number): number {
  return Math.round(bytes / 2 ** 30)
}

/** Memory in use: the total less what is free to take, in GB with one decimal, and its share. */
export function memoryUse(f: MachineFigures | undefined): { used: number; total: number; pct: number } | undefined {
  if (!f?.mem_total) return undefined
  const used = Math.max(0, f.mem_total - (f.mem_available ?? 0))
  return { used: used / 2 ** 30, total: gb(f.mem_total), pct: Math.min(100, Math.round((used / f.mem_total) * 100)) }
}

/** The processor's share from the one-minute load over the cores; undefined without a load (Windows). */
export function cpuPct(f: MachineFigures | undefined): number | undefined {
  if (!f || f.load1 == null || !f.cpus) return undefined
  return Math.min(100, Math.round((f.load1 / f.cpus) * 100))
}

/** A bar turns amber at 70% and over. */
export function meterWarn(pct: number): boolean {
  return pct >= 70
}

/** The agents ready there, by name; from a Caprock before the switches, its one agent when installed and signed in. */
export function agentsReady(r: SetupReport | undefined): string[] {
  if (!r) return []
  if (r.agents) return readyAgents(r)
  const a = item(r, 'agent')
  return done(a) && done(item(r, 'signin')) && a?.label ? [a.label] : []
}

/** "2 projects." → 2; undefined when the check says none or has no such item. */
export function projectsThere(r: SetupReport | undefined): number | undefined {
  const p = item(r, 'project')
  if (p?.state !== 'ok') return undefined
  const m = /^(\d+) project/.exec(p.detail)
  return m ? Number(m[1]) : undefined
}

/**
 * How a computer stands for these views. `down` is a computer that cannot
 * be read now: offline, or a state that needs something (waiting for Allow,
 * removed there, refused). What its session list said last outranks the
 * list's state: it was asked later.
 */
export function machineState(m: Pick<Machine, 'status'>, read?: Pick<MachineSessions, 'status'>): { online: boolean; offline: boolean; down: boolean } {
  const bad = (s?: string) => s === 'offline' || s === 'revoked' || s === 'refused' || s === 'pending'
  const down = bad(read?.status) || bad(m.status)
  const offline = read?.status === 'offline' || (!bad(read?.status) && m.status === 'offline')
  return { online: !down && (m.status === 'online' || read?.status === 'online'), offline, down }
}

/** "seen 3d ago", or "not seen yet". */
export function seenAgo(lastSeen: number | undefined, now = Date.now()): string {
  return lastSeen ? `seen ${fmtAgo(lastSeen, now)}` : 'not seen since this Caprock started'
}

/**
 * The sidebar row's second line: *macOS · 36 GB · 2 running*, *Windows ·
 * 32 GB · idle*, or for an offline computer *offline · seen 3d ago*. A part
 * not known yet is left out.
 */
export function machineLine(p: { offline: boolean; state?: string; lastSeen?: number; spec?: MachineSpec; running: number; now?: number }): string {
  if (p.offline) return `offline · ${seenAgo(p.lastSeen, p.now)}`
  if (p.state) return p.state
  const parts: string[] = []
  const os = osName(p.spec?.setup?.os)
  if (os) parts.push(os)
  if (p.spec?.machine?.mem_total) parts.push(`${gb(p.spec.machine.mem_total)} GB`)
  parts.push(p.running > 0 ? `${p.running} running` : 'idle')
  return parts.join(' · ')
}
