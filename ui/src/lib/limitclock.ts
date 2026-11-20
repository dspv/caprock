/**
 * "9m", "1h 39m", "2d 16h" until a moment: minutes under an hour. Units close
 * up to their numbers: "2 d 16 h" read as four loose pieces (owner,
 * 2026-11-20, translated: "a pile of spaces, make it shorter").
 */
export function countdown(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`
}

/**
 * "15:20" today, "tomorrow 17:11" the next day, "Tue 14:00" further away.
 * Only a moment on today's date goes without its day: "out at 17:11" read
 * at 19:54 looked like a time already past when it meant tomorrow (owner,
 * 2026-11-20, translated: "the dates don't add up").
 */
export function resetClock(resetMs: number, now: number): string {
  const at = new Date(resetMs)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(at) - day(new Date(now))) / 86_400_000)
  if (days <= 0) return time
  if (days === 1) return `tomorrow ${time}`
  return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
}
