/** "9 min", "1 h 39 min", "3 d 4 h" until a moment: minutes under an hour. */
export function countdown(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

/** "15:20" within a day, "Tue 14:00" further away — a weekly reset needs its day. */
export function resetClock(resetMs: number, now: number): string {
  if (resetMs - now > 24 * 3600 * 1000) {
    return new Date(resetMs).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  }
  return new Date(resetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
