/**
 * The daemon's answer to "which of these folders are on GitHub"
 * (`GET /v1/repos/remotes`) for the repositories agent sessions worked in:
 * what the Pipeline's picker and Home's Pipeline card filter and fold by
 * (lib/pipeline). Asked again only when the set of folders changes — a
 * remote changes far less often than that — and kept in this browser, so the
 * picker draws filtered at once on the next visit (one entry, by folder: a
 * folder missing from it is not yet known and is listed). Undefined until the first
 * answer: the picker then lists every git repository, as before.
 */
import { useMemo } from 'react'
import { api, type SessionSummary } from './api'
import { useApi } from './useApi'
import { remoteDirs, type RepoRemotes } from './pipeline'

export function useRepoRemotes(sessions: readonly SessionSummary[] | undefined): RepoRemotes | undefined {
  const dirs = useMemo(() => remoteDirs(sessions ?? []), [sessions])
  const key = dirs.join('\n')
  const got = useApi(() => (dirs.length > 0 ? api.repoRemotes(dirs) : Promise.resolve({ repos: [] })), [key], { live: false, cache: dirs.length > 0 ? 'repo-remotes' : undefined, share: false })
  return useMemo(() => (got.data ? new Map(got.data.repos.map((r) => [r.dir, r])) : undefined), [got.data])
}
