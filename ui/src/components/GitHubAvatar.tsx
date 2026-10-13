/**
 * A GitHub account's face and name (owner, 2026-10-14, translated: "who
 * pushes there — literally face and name"). The picture is the avatar_url
 * GitHub returned with the pull request, loaded from
 * avatars.githubusercontent.com — only ever while GitHub is connected, since
 * nothing else carries one (rule 4; docs/app.md § GitHub). Sent without a
 * referrer; when it does not load (offline, blocked) the initials stand in.
 */
import { useState } from 'react'
import { initials } from '@/lib/prboard'

/** Only GitHub's own avatar host is loaded; any other address draws the initials. */
function safeAvatar(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'avatars.githubusercontent.com' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

export function GitHubAvatar({ login, url, size = 16 }: { login: string; url?: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  const src = failed ? undefined : safeAvatar(url)
  const box = { width: size, height: size }
  if (!src) {
    return (
      <span aria-hidden style={{ ...box, fontSize: Math.max(8, Math.round(size * 0.45)) }}
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-panel-2 font-medium leading-none text-fg-muted">
        {initials(login)}
      </span>
    )
  }
  return <img src={src} alt="" style={box} width={size} height={size} referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} className="shrink-0 rounded-full bg-panel-2" />
}

/** Face and name side by side. */
export function GitHubPerson({ login, url, size = 16, className = '' }: { login?: string; url?: string; size?: number; className?: string }) {
  if (!login) return null
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={`@${login} on GitHub`}>
      <GitHubAvatar login={login} url={url} size={size} />
      <span className="truncate">{login}</span>
    </span>
  )
}
