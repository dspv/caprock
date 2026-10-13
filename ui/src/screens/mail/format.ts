import type { Address, Message } from './mailApi'

export function sender(m: Pick<Message, 'from_name' | 'from_addr'>) {
  return m.from_name || m.from_addr || '(unknown)'
}

export function firstName(a: Address) {
  return a.name ? a.name.split(/\s+/)[0] : a.addr
}

export function people(as: Address[] | null | undefined) {
  return (as ?? []).map((a) => (a.name ? `${a.name} <${a.addr}>` : a.addr)).join(', ')
}

const dayMs = 86400000

// Today: time. This week: weekday. This year: day month. Older: full date.
export function shortDate(unix: number, now = new Date()) {
  const d = new Date(unix * 1000)
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (d.getTime() >= startToday) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.getTime() >= startToday - dayMs) return 'Yesterday'
  if (d.getTime() >= startToday - 6 * dayMs) return d.toLocaleDateString([], { weekday: 'long' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

export function longDate(unix: number) {
  return new Date(unix * 1000).toLocaleString([], {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Parses "Ana <ana@x.com>, bo@y.com" into addresses.
export function parseAddresses(s: string): Address[] {
  const out: Address[] = []
  for (const raw of s.split(/[,;]/)) {
    const t = raw.trim()
    if (!t) continue
    const m = t.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
    if (m) out.push({ name: (m[1] ?? '').trim(), addr: (m[2] ?? '').trim() })
    else out.push({ name: '', addr: t })
  }
  return out
}

export function validAddress(a: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)
}

export function initials(name: string) {
  const parts = name.replace(/[<>"]/g, '').trim().split(/[\s.@_-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
}

// A stable hue per address, so a sender keeps one colour everywhere.
export function hue(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

export function replySubject(s: string, prefix: 'Re' | 'Fwd') {
  const re = prefix === 'Re' ? /^\s*re:/i : /^\s*(fwd?|fw):/i
  return re.test(s) ? s : `${prefix}: ${s}`
}

export function quote(m: Message) {
  const when = longDate(m.date)
  const body = (m.body_text ?? '').replace(/\s+$/, '').split('\n').map((l) => '> ' + l).join('\n')
  return `\n\nOn ${when}, ${sender(m)} wrote:\n${body}`
}
