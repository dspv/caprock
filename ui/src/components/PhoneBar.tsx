/**
 * The phone home's header (owner, 2026-10-13: the phone home should feel like
 * an app, not the desktop dashboard squeezed). The desktop header — six nav
 * tabs, Share, Get premium, Feedback, the plan chip, the theme, the version,
 * Settings — wrapped to three rows at 390 px. Here it is one row: the mark
 * and the connection's state on the left, one ⋯ on the right holding
 * Dashboard, Settings, Feedback and Get premium — and, on a phone the owner
 * made a controller, each private module the machine's admin key opens
 * (ADR-076). Every other screen keeps the desktop header (components/Shell.tsx),
 * whose nav lists the modules too.
 */
import { useEffect, useRef, useState } from 'react'
import type { useLiveLink } from '@/lib/live'

type LinkStatus = ReturnType<typeof useLiveLink>
import { BugIcon, CaprockMark, ChatIcon, DashboardIcon, MoreIcon, SettingsIcon } from './AppIcons'
import { ConnectionState } from './ConnectionState'
import { FeedbackDialog } from './Feedback'
import { PremiumModal } from './PremiumModal'
import { useModules } from '@/lib/modules'

export function PhoneBar({ link, heardAt }: { link: LinkStatus; heardAt: () => number }) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState(false)
  const [premium, setPremium] = useState(false)
  const mods = useModules()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const item = 'flex min-h-12 w-full items-center gap-3 px-4 text-left text-[16px] text-fg no-underline hover:no-underline active:bg-panel-2'
  return (
    <header data-shell-header data-phone-bar className="sticky top-0 z-20 flex min-h-12 items-center gap-2 border-b border-border bg-panel px-4 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]">
      <a href="#/" className="flex items-center gap-2 text-fg no-underline hover:no-underline">
        <CaprockMark size={20} />
        <span className="text-[17px] font-semibold tracking-tight">Caprock</span>
      </a>
      <span className="text-[12px] text-fg-muted"><ConnectionState link={link} heardAt={heardAt} /></span>
      <div ref={box} className="relative ml-auto">
        <button
          type="button"
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="grid h-11 w-11 place-items-center rounded-full text-fg-muted active:bg-panel-2"
        >
          <MoreIcon size={22} />
        </button>
        {open && (
          <div role="menu" aria-label="More" className="absolute right-0 top-[calc(100%+4px)] w-[230px] overflow-hidden rounded-[12px] border border-border-strong bg-panel py-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.6)]">
            <a role="menuitem" href="#/chats" className={item} onClick={() => setOpen(false)}>
              <ChatIcon size={18} /> Chats
            </a>
            <a role="menuitem" href="#/home" className={item} onClick={() => setOpen(false)}>
              <DashboardIcon size={18} /> Dashboard
            </a>
            {mods.map((m) => (
              <a key={m.id} role="menuitem" data-module-item={m.id} href={`#/x/${m.id}`} className={item} onClick={() => setOpen(false)}>
                <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] bg-accent text-[11px] font-semibold uppercase text-panel">{m.name.slice(0, 1)}</span> {m.name}
              </a>
            ))}
            <a role="menuitem" href="#/settings" className={item} onClick={() => setOpen(false)}>
              <SettingsIcon size={18} /> Settings
            </a>
            <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); setFeedback(true) }}>
              <BugIcon size={18} className="text-accent" /> Feedback
            </button>
            <button type="button" role="menuitem" className={item.replace("text-fg ", "text-premium-strong ")} onClick={() => { setOpen(false); setPremium(true) }}>
              <span aria-hidden className="w-[18px] text-center">★</span> Get premium
            </button>
          </div>
        )}
      </div>
      {feedback && <FeedbackDialog screen="phone home" onClose={() => setFeedback(false)} />}
      {premium && <PremiumModal feature="cap" onClose={() => setPremium(false)} />}
    </header>
  )
}
