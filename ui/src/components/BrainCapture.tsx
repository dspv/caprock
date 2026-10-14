/**
 * The quick capture (ADR-063): one line, or a paragraph, dropped into Second
 * Brain from anywhere — ⇧⌘H, or ⌘K "Add to Second Brain…". The first line becomes
 * the memory's title, the rest its summary; the kind and topics are optional.
 *
 * `BrainCaptureHost` is mounted once per page (App, AppShell) and opens the
 * sheet whenever BRAIN_CAPTURE_EVENT is said on window, so a palette item, a
 * shortcut or a button anywhere needs no prop threaded down to it.
 */
import { useEffect, useState } from 'react'
import { keys } from '@/lib/appkeys'
import { BRAIN_CAPTURE_EVENT, dropIntoBrain, MEMORY_KINDS } from '@/lib/brain'
import type { BrainKind } from '@/lib/api'
import { Sheet, SheetButton, SheetField } from './Sheet'

export function BrainCaptureHost() {
  const [open, setOpen] = useState<{ text: string; n: number } | null>(null)
  useEffect(() => {
    const on = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text ?? ''
      setOpen((cur) => ({ text, n: (cur?.n ?? 0) + 1 }))
    }
    window.addEventListener(BRAIN_CAPTURE_EVENT, on)
    return () => window.removeEventListener(BRAIN_CAPTURE_EVENT, on)
  }, [])
  if (!open) return null
  return <BrainCapture key={open.n} initial={open.text} onClose={() => setOpen(null)} />
}

export function BrainCapture({ initial = '', onClose }: { initial?: string; onClose: () => void }) {
  const [text, setText] = useState(initial)
  const [kind, setKind] = useState<BrainKind>('idea')
  const [topics, setTopics] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError('')
    const r = await dropIntoBrain({
      text,
      kind,
      topics: topics.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8),
    })
    setBusy(false)
    if (r.ok) { onClose(); return }
    setError(r.message)
  }
  return (
    <>
      <Sheet
        label="Add to Second Brain"
        title="Add to Second Brain"
        onClose={onClose}
        width={560}
        footer={
          <>
            <span className="mr-auto text-[12px] text-fg-faint">
              Kept on this machine.
            </span>
            <SheetButton primary disabled={!text.trim() || busy} onClick={() => void send()} aria-keyshortcuts="Meta+Enter" keyHint={keys('⌘↩')}>
              Drop it in
            </SheetButton>
          </>
        }
      >
        <div className="grid gap-4 px-5 py-4">
          <SheetField label="What to keep" hint="the first line is its title">
            <textarea
              autoFocus
              data-brain-capture
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() }
              }}
              placeholder="A decision, a finding, an idea worth keeping…"
              className="input min-h-[96px] w-full resize-y text-[14px] leading-relaxed"
            />
          </SheetField>
          <div role="radiogroup" aria-label="Kind" className="flex flex-wrap gap-1.5">
            {MEMORY_KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={kind === k.kind}
                title={k.hint}
                onClick={() => setKind(k.kind)}
                className={`h-[28px] rounded-[7px] border px-2.5 text-[12.5px] ${
                  kind === k.kind ? 'border-accent/60 bg-accent/10 text-fg' : 'border-[var(--app-hairline-strong)] text-fg-muted hover:text-fg'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
          <SheetField label="Topics" hint="optional, comma-separated">
            <input value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="sqlite, pricing" className="input w-full" />
          </SheetField>
          {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
        </div>
      </Sheet>
    </>
  )
}
