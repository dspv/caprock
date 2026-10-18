import { useCallback, useEffect, useState } from 'react'
import { api, errText, type BrainVault } from '@/lib/api'
import { useBrainFrames } from '@/lib/brain'
import { fmtAgo } from '@/lib/format'
import { isTauri } from '@/lib/appmode'
import { shell } from '@/lib/shell'
import { Sheet, SheetButton } from '@/components/Sheet'

/** Local vaults, their refresh state and the separate choice to share notes with agents (ADR-079). */
export function ObsidianVaults({ onClose }: { onClose: () => void }) {
  const [vaults, setVaults] = useState<BrainVault[]>([])
  const [path, setPath] = useState('')
  const [agents, setAgents] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<number>()
  const load = useCallback(() => {
    void api.brainVaults().then((r) => setVaults(r.vaults), (e: unknown) => setError(errText(e)))
  }, [])
  useEffect(load, [load])
  useBrainFrames(load)
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(errText(e)) } finally { setBusy(false); load() }
  }
  return (
    <Sheet title="Import from Obsidian" label="Obsidian vaults" width={620} onClose={onClose}
      footer={<SheetButton onClick={onClose}>Done</SheetButton>}>
      <div className="grid gap-4 px-5 py-4">
        <p className="text-[13px] leading-relaxed text-fg-muted">
          Read the Markdown notes in a vault. Links and tags join Second Brain; your files stay unchanged.
          Caprock checks for changes every 10 minutes while it runs.
        </p>
        <form className="grid gap-2" onSubmit={(e) => {
          e.preventDefault()
          void act(async () => { await api.addBrainVault(path.trim(), agents); setPath(''); setAgents(false) })
        }}>
          <label className="grid gap-1 text-[13px] text-fg">
            Vault folder on this computer
            <input autoFocus aria-label="Vault folder" className="input w-full" value={path} spellCheck={false}
              placeholder="Full path to your vault" disabled={busy} onChange={(e) => setPath(e.target.value)} />
          </label>
          <div className="flex gap-2">
            {isTauri() && <SheetButton disabled={busy} onClick={() => void act(async () => {
              const picked = await shell.pickFolder(path.trim() || undefined)
              if (picked) setPath(picked)
            })}>Choose folder…</SheetButton>}
            <SheetButton primary disabled={busy || !path.trim()} type="submit">{busy ? 'Working…' : 'Import vault'}</SheetButton>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input type="checkbox" checked={agents} disabled={busy} onChange={(e) => setAgents(e.target.checked)} />
            Let agents use these notes
          </label>
          <p className="text-[12px] leading-relaxed text-fg-muted">
            Off keeps imported notes in Caprock. On lets agents read them through MCP and memory handoffs,
            and lets Second Brain send their topic names to your model. Answers can reach the model your agent uses.
          </p>
        </form>
        {error && <p role="alert" className="text-[13px] text-danger [overflow-wrap:anywhere]">{error}</p>}
        <ul aria-label="Imported vaults" className="grid gap-3">
          {vaults.map((v) => (
            <li key={v.id} className="grid min-w-0 gap-2 rounded-[var(--radius-panel)] border border-border p-3">
              <div className="min-w-0">
                <h3 className="truncate text-[14px] font-medium text-fg">{v.name}</h3>
                <p className="mono break-all text-[11.5px] text-fg-muted">{v.path}</p>
                <p className="text-[12px] text-fg-muted">{v.notes} {v.notes === 1 ? 'note' : 'notes'} · {v.scanned_at ? `checked ${fmtAgo(v.scanned_at)}` : 'not checked yet'}</p>
              </div>
              {v.error && <p role="status" className="text-[12px] text-danger [overflow-wrap:anywhere]">{v.error}</p>}
              <label className="flex items-center gap-2 text-[12.5px] text-fg">
                <input type="checkbox" aria-label={`Let agents use ${v.name}`} checked={v.agents} disabled={busy}
                  onChange={(e) => void act(() => api.patchBrainVault(v.id, e.target.checked))} />
                Let agents use these notes
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <SheetButton disabled={busy} onClick={() => void act(() => api.refreshBrainVault(v.id))}>Refresh now</SheetButton>
                {confirm === v.id ? <>
                  <span className="text-[12px] text-fg-muted">Remove this import? Your files stay.</span>
                  <SheetButton disabled={busy} onClick={() => void act(async () => { await api.removeBrainVault(v.id); setConfirm(undefined) })}>Remove import</SheetButton>
                  <SheetButton disabled={busy} onClick={() => setConfirm(undefined)}>Keep</SheetButton>
                </> : <SheetButton disabled={busy} onClick={() => setConfirm(v.id)}>Remove…</SheetButton>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  )
}
