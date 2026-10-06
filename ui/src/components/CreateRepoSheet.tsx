/**
 * Put a local project on GitHub (WP-19): a new repository — private unless
 * you say otherwise — under your account or an organization, set as the
 * project's `origin`, and the current branch pushed through the Changes push
 * (your git credentials; Caprock's token never reaches git). Each of the
 * three steps can fail on its own, and the sheet says which did.
 */
import { useEffect, useState } from 'react'
import { githubApi, githubErrorText, type CreateRepoResult, type GitHubOwner } from '@/lib/github'
import { Sheet, SheetButton, SheetField } from './Sheet'

/** A folder name made into a repository name GitHub keeps as typed. */
export function repoNameFrom(folder: string): string {
  return folder.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
}

export function CreateRepoSheet({ projectId, defaultName, onClose, onDone }: { projectId: string; defaultName: string; onClose: () => void; onDone: (r: CreateRepoResult) => void }) {
  const [name, setName] = useState(() => repoNameFrom(defaultName))
  const [owners, setOwners] = useState<GitHubOwner[]>([])
  const [owner, setOwner] = useState('')
  const [isPrivate, setPrivate] = useState(true)
  const [description, setDescription] = useState('')
  const [protocol, setProtocol] = useState<'https' | 'ssh'>('https')
  const [push, setPush] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<CreateRepoResult | null>(null)

  useEffect(() => {
    githubApi.owners().then(setOwners).catch((e: unknown) => setError(githubErrorText(e)))
  }, [])

  const submit = async () => {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) { setError('A repository name is letters, digits, “.”, “-” and “_”.'); return }
    setBusy(true)
    setError('')
    try {
      const r = await githubApi.createRepo(projectId, { name, owner: owner || undefined, private: isPrivate, description: description.trim() || undefined, protocol, push })
      setDone(r)
      if (!r.push_error) onDone(r)
    } catch (e) {
      setError(githubErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      label="Create a GitHub repository"
      title="Create a GitHub repository"
      onClose={onClose}
      footer={
        <>
          {error && <p role="alert" className="mr-auto min-w-0 text-[12px] leading-snug text-danger [overflow-wrap:anywhere]">{error}</p>}
          <SheetButton onClick={onClose}>{done ? 'Close' : 'Cancel'}</SheetButton>
          {!done && <SheetButton primary disabled={busy} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create'}</SheetButton>}
        </>
      }
    >
      {done ? (
        <div className="grid gap-2 px-5 py-4 text-[12.5px]">
          <p className="text-fg"><span className="text-ok">✓</span> Created <a href={done.repo.html_url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{done.repo.full_name}</a>{done.repo.private ? ' (private)' : ''}, set as <span className="mono">{done.remote}</span>.</p>
          {done.pushed && <p className="text-fg"><span className="text-ok">✓</span> Pushed.</p>}
          {done.push_error && (
            <div role="alert" className="grid gap-1 rounded-[8px] border border-danger/40 bg-danger/[0.06] px-2.5 py-2">
              <p>The push failed: {done.push_error.error}. Push again from Changes once that is fixed.</p>
              {done.push_error.output && <pre className="app-scroll mono max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-fg-muted">{done.push_error.output}</pre>}
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4 px-5 py-4">
          <div className="flex min-w-0 gap-2">
            {owners.length > 1 && (
              <SheetField label="Owner">
                <select className="input" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner">
                  {owners.map((o, i) => <option key={o.login} value={i === 0 ? '' : o.login}>{o.login}</option>)}
                </select>
              </SheetField>
            )}
            <div className="min-w-0 flex-1">
              <SheetField label="Name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Repository name" spellCheck={false} />
              </SheetField>
            </div>
          </div>
          <SheetField label="Description" hint="optional">
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
          </SheetField>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
            Private
          </label>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
            Push the current branch after
          </label>
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-fg-muted">
            <span>Remote address</span>
            {(['https', 'ssh'] as const).map((p) => (
              <label key={p} className="flex items-center gap-1">
                <input type="radio" name="repo-protocol" checked={protocol === p} onChange={() => setProtocol(p)} className="accent-[var(--color-accent)]" />
                {p === 'https' ? 'HTTPS' : 'SSH'}
              </label>
            ))}
            <span className="text-fg-faint">— how your git signs in to push</span>
          </div>
        </div>
      )}
    </Sheet>
  )
}
