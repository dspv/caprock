/**
 * Send secrets (ADR-107, issue #1095): copy chosen credentials from this
 * computer's secret store into a linked computer's, on a click, so setting
 * that computer up never needs SSH.
 *
 * The page never holds a value. It lists names (`GET /v1/machines/secrets`)
 * and sends names (`POST /v1/machines/<id>/secrets`); the daemon reads the
 * values from its own store and carries them to the computer inside the
 * end-to-end encrypted link, where they are written straight into its store.
 * The computer lists what arrived, by name and when (`GET /v1/secrets/received`).
 */
import { ApiError } from './api'

/** One credential this computer can send. Never a value. */
export interface SecretItem {
  /** `github`, `deepseek` or `kimi`. */
  name: string
  label: string
  /** Held on this computer now. */
  set: boolean
  /** Why it cannot be sent, when that is not obvious. */
  note?: string
}

/** What the computer kept, by name, and what it could not, with why. */
export interface SecretReceipt {
  stored: string[]
  failed: { name: string; error: string }[]
}

/** One send that reached this computer. */
export interface SecretArrival {
  from_id: string
  from: string
  names: string[]
  /** Unix ms. */
  at: number
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const write = !!init?.method && init.method !== 'GET'
  const res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json' } : {}) } })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  return (await res.json()) as T
}

export const secretsApi = {
  /** What this computer can send, set here or not. */
  here: () => call<{ secrets?: SecretItem[] }>('/v1/machines/secrets').then((r) => r.secrets ?? []),
  /** Sends the named ones to computer `id`, on the user's click only. */
  send: (id: string, names: string[]) =>
    call<SecretReceipt>(`/v1/machines/${encodeURIComponent(id)}/secrets`, { method: 'POST', body: JSON.stringify({ names }) }),
  /** What arrived on this computer, newest first. */
  received: () => call<{ arrivals?: SecretArrival[] }>('/v1/secrets/received').then((r) => r.arrivals ?? []),
}

/** "GitHub token and DeepSeek key" from names, by the labels known here. */
export function secretNames(names: readonly string[], items?: readonly SecretItem[]): string {
  const label = (n: string) => items?.find((i) => i.name === n)?.label ?? SECRET_LABELS[n] ?? n
  const all = names.map(label)
  if (all.length <= 1) return all.join('')
  return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`
}

/** The labels, for a computer that lists what arrived without asking for them. */
export const SECRET_LABELS: Record<string, string> = { github: 'GitHub token', deepseek: 'DeepSeek key', kimi: 'Kimi key' }

/** The newest arrival from each computer, by its device id. */
export function latestByComputer(arrivals: readonly SecretArrival[] | undefined): Map<string, SecretArrival> {
  const out = new Map<string, SecretArrival>()
  for (const a of arrivals ?? []) {
    const had = out.get(a.from_id)
    if (!had || a.at > had.at) out.set(a.from_id, a)
  }
  return out
}

/** A failed send, said for a person. */
export function sendError(e: unknown, name: string): string {
  if (e instanceof ApiError) {
    const said = (e.body as { error?: string } | undefined)?.error
    if (e.status === 501 && said) return said
    if (e.status === 503) return `${name} is offline. Nothing was sent.`
    if (e.status === 504) return `${name} did not answer in time. Try again.`
    if (said) return said
  }
  return e instanceof Error ? e.message : String(e)
}
