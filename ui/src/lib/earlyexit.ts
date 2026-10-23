/**
 * The words for a session whose program exited a moment after it started
 * (components/EarlyExit.tsx; the daemon's ExitReport, GET
 * /v1/agents/{id}/exit). Pure, so they are tested.
 *
 * Before, such a tab read "Connecting to the session… Can't connect · next
 * try in 5 s" over a process that was long gone, and nothing anywhere said
 * what it had printed (a user pressing Continue here five times, Caprock
 * 0.154.2, 2026-10-24).
 */

/** "Claude Code exited at once (code 1)". */
export function earlyExitHeadline(agent: string, code: number): string {
  return `${agent} exited at once (code ${code})`
}

/** "It ended 0.1 s after it started, before anything was typed." */
export function earlyExitWhen(ranMs: number | undefined): string {
  if (ranMs === undefined || ranMs < 0) return 'It ended right after it started, before anything was typed.'
  const s = ranMs < 1000 ? `${Math.round(ranMs)} ms` : `${Math.round(ranMs / 1000)} s`
  return `It ended ${s} after it started, before anything was typed.`
}

/**
 * What the printed lines usually mean, when they say something known
 * (measured with Claude Code 2.1.309, 2026-10-24): one sentence with what to
 * do, or undefined. The lines themselves are always shown; this is a reading
 * of them, never a replacement.
 */
export function earlyExitHint(tail: string): string | undefined {
  const t = tail.toLowerCase()
  if (t.includes('no conversation found')) {
    return 'Claude Code looks for a conversation only under the folder it was started in, and did not find this one there. Continue it from the folder the conversation began in, or from its own terminal.'
  }
  if (t.includes('already in use')) {
    return 'Another process is running this session id. Try again starts a copy under a new one.'
  }
  if (t.includes('eperm') || t.includes('operation not permitted') || t.includes('uv_cwd')) {
    return 'macOS did not let it read this folder. Allow it in System Settings → Privacy & Security → Files and Folders, then try again.'
  }
  if (t.includes('malformed json') || t.includes('settingserror') || t.includes('settings error') || t.includes('invalid settings')) {
    return 'A Claude Code settings file is not valid JSON. Fix it or move it away, then try again.'
  }
  if (t.includes('is invalid. allowed choices') || t.includes('unknown option') || t.includes('error: option')) {
    return 'This copy of the agent refused a flag Caprock passed. Caprock’s background service may start an older copy than your terminal does: compare the path above with `which claude`, and update or remove the old one.'
  }
  if (t.includes('not logged in') || t.includes('/login') || t.includes('invalid api key')) {
    return 'It is not signed in. Run it once in a terminal and sign in, then try again.'
  }
  return undefined
}
