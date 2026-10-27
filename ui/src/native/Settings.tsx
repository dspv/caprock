/**
 * The iOS app's own Settings (the approved mockup's screen 8), laid over the
 * page at `#/app-settings`: the paired computer and what this phone may do
 * there, the voice language (with whether this iPhone recognises it on its
 * own), the Face ID lock, and unpairing. Nothing here sells anything.
 *
 * Notifications are not in this version: push waits on OQ-24 (ADR-083).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { COMMON_SPEECH_LANGS, dedupeLangs, langName, myLangs, setSpeechLang, speechLang } from '@/lib/speechlang'
import { currentChannel, currentMachine, forgetMachine, machines } from '@/remote/boot'
import { keepPairing, lockWanted, setLockWanted, wipePairing } from './keychain'
import { lockKind, unlock, type LockKind } from './lock'
import { DEMO_MACHINE_NAME } from './demo/index'

/** What a role lets this phone do, in the words of the mockup. */
export function roleWords(role: string | undefined): string {
  if (role === 'controller' || role === 'owner') return 'type, start, approve'
  if (role === 'viewer') return 'read only'
  return '—'
}

export default function AppSettings({ demo, onClose }: { demo: boolean; onClose: () => void }) {
  const [view, setView] = useState<'main' | 'voice'>('main')
  if (view === 'voice') return <VoiceLanguage onBack={() => setView('main')} />
  return <Main demo={demo} onClose={onClose} onVoice={() => setView('voice')} />
}

function Screen({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} data-testid="app-settings"
      className="fixed inset-0 z-[100] overflow-y-auto bg-bg pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[env(safe-area-inset-top)]">
      <div className="mx-auto max-w-md">
        <div className="flex items-center gap-2 px-4 pb-2 pt-1.5">
          <button type="button" onClick={onBack} aria-label="Back" className="-ml-2.5 grid h-11 w-11 place-items-center rounded-full text-accent">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 5-7 7 7 7" /></svg>
          </button>
          <h1 className="flex-1 text-[30px] font-bold tracking-[-0.01em] text-fg">{title}</h1>
        </div>
        <div className="grid gap-1.5 px-4">{children}</div>
      </div>
    </div>
  )
}

const label = 'px-1 pb-1 pt-3 text-[12px] font-medium uppercase tracking-[0.08em] text-fg-faint'
const group = 'overflow-hidden rounded-xl border border-border bg-panel'
const row = 'flex min-h-[46px] items-center gap-2.5 border-t border-border px-3 py-2 text-[15.5px] text-fg first:border-t-0'
const foot = 'px-1 pt-1 text-[12.5px] leading-snug text-fg-faint'

function Toggle({ on, disabled, onChange, label: name }: { on: boolean; disabled?: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={name} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative ml-auto h-[31px] w-[51px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-ok' : 'bg-border-strong'}`}>
      <span className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-[left] ${on ? 'left-[22px]' : 'left-[2px]'}`} />
    </button>
  )
}

function Main({ demo, onClose, onVoice }: { demo: boolean; onClose: () => void; onVoice: () => void }) {
  const machine = currentMachine()
  const ch = currentChannel()
  const [role, setRole] = useState<string | undefined>()
  const [lock, setLock] = useState<LockKind | null>(null)
  const [locked, setLocked] = useState(false)
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void lockKind().then(setLock)
    void lockWanted().then(setLocked)
    api.pairMe().then((m) => setRole(m.role), () => setRole(undefined))
  }, [])

  const name = demo ? DEMO_MACHINE_NAME : machine?.name ?? 'Your computer'
  const connected = demo || ch?.state === 'open'

  async function switchLock(on: boolean) {
    setNote('')
    if (!(await unlock(on ? 'Turn on the lock' : 'Turn off the lock'))) return
    try {
      await setLockWanted(on)
      setLocked(on)
    } catch {
      setNote('The Keychain did not take the change. Try again.')
    }
  }

  async function unpair() {
    if (!machine) return
    setBusy(true)
    // Tell the computer first, so it shows this phone as removed; best effort,
    // since an unpair must work with the computer asleep too.
    await Promise.race([api.pairForgetMe().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
    forgetMachine(machine.id)
    if (machines().length === 0) await wipePairing()
    else await keepPairing()
    window.location.replace(window.location.pathname + '#/')
    window.location.reload()
  }

  return (
    <Screen title="Settings" onBack={onClose}>
      <div className={label}>Paired computer</div>
      <ul className={group}>
        <li className={row}>
          <span aria-hidden className={`h-[9px] w-[9px] shrink-0 rounded-full ${connected ? 'bg-ok' : 'bg-warn'}`} />
          <span className="min-w-0 flex-1">
            {name}
            <span className="mt-px block text-[12.5px] leading-tight text-fg-faint">
              {demo ? 'Sample data: connects to nothing' : connected ? 'Connected through the relay, end to end encrypted' : 'Not connected right now'}
            </span>
          </span>
        </li>
        <li className={row}>
          <span className="flex-1">This phone can</span>
          <span className="text-right text-[14.5px] text-fg-muted">{roleWords(role)}</span>
        </li>
      </ul>

      <div className={label}>Voice</div>
      <ul className={group}>
        <li>
          <button type="button" onClick={onVoice} className={`${row} w-full text-left`}>
            <span className="min-w-0 flex-1">
              Language
              <span className="mt-px block text-[12.5px] leading-tight text-fg-faint">Recognised on this iPhone</span>
            </span>
            <span className="text-[14.5px] text-fg-muted">{langName(speechLang())} ›</span>
          </button>
        </li>
      </ul>

      <div className={label}>Security</div>
      <ul className={group}>
        <li className={row}>
          <span className="min-w-0 flex-1">
            Lock with {lock?.name ?? 'Face ID'}
            {lock && !lock.available && <span className="mt-px block text-[12.5px] leading-tight text-fg-faint">{lock.why}</span>}
          </span>
          <Toggle on={locked} disabled={!lock?.available} onChange={(on) => void switchLock(on)} label={`Lock with ${lock?.name ?? 'Face ID'}`} />
        </li>
      </ul>
      {note && <p className="px-1 text-[13px] text-danger">{note}</p>}

      {!demo && machine && (
        <>
          <ul className={`${group} mt-3.5`}>
            <li>
              <button type="button" onClick={() => setConfirming(true)} className={`${row} w-full justify-center font-medium text-danger`}>
                Unpair this phone
              </button>
            </li>
          </ul>
          <p className={foot}>Deletes this phone&apos;s keys. {name} shows it as removed, and you can pair again with a new code.</p>
        </>
      )}

      {confirming && (
        <div role="alertdialog" aria-modal="true" aria-label="Unpair this phone" className="fixed inset-0 z-[110] flex items-end justify-center bg-black/50 px-3 pb-[max(1rem,env(safe-area-inset-bottom))]" onClick={() => !busy && setConfirming(false)}>
          <div className="w-full max-w-md rounded-[14px] border border-border-strong bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-[17px] font-semibold text-fg">Unpair from {name}?</p>
            <p className="mt-1.5 text-[15px] leading-snug text-fg-muted">This phone forgets its keys. To use it again, scan a new code on the computer.</p>
            <div className="mt-4 grid gap-2">
              <button type="button" disabled={busy} onClick={() => void unpair()} className="min-h-12 rounded-xl bg-danger text-[17px] font-semibold text-bg disabled:opacity-60">
                {busy ? 'Unpairing…' : 'Unpair'}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="min-h-11 text-[16px] text-fg-muted">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  )
}

/**
 * The dictation language, chosen from this viewer's languages and the common
 * ones, each saying whether this iPhone recognises it on its own. One that it
 * does not is still listed: choosing it says so, and nothing is sent anywhere.
 */
function VoiceLanguage({ onBack }: { onBack: () => void }) {
  const [current, setCurrent] = useState(speechLang)
  const [onDevice, setOnDevice] = useState<Record<string, boolean>>({})
  const tags = dedupeLangs([...myLangs(), ...COMMON_SPEECH_LANGS.map(([t]) => t)])
  useEffect(() => {
    let live = true
    void import('./speech').then(async ({ onDevice: check }) => {
      for (const t of tags) {
        const ok = await check(t)
        if (!live) return
        setOnDevice((m) => ({ ...m, [t]: ok }))
      }
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list is fixed while open
  }, [])
  return (
    <Screen title="Voice" onBack={onBack}>
      <p className={foot}>What you say is turned into text on this iPhone. A language it cannot recognise on its own is not sent anywhere instead.</p>
      <ul className={`${group} mt-2`} role="radiogroup" aria-label="Dictation language">
        {tags.map((t) => (
          <li key={t}>
            <button type="button" role="radio" aria-checked={t === current} onClick={() => { setSpeechLang(t); setCurrent(speechLang()) }} className={`${row} w-full text-left`}>
              <span className="min-w-0 flex-1">
                {langName(t)}
                <span className={`mt-px block text-[12.5px] leading-tight ${onDevice[t] === false ? 'text-warn' : 'text-fg-faint'}`}>
                  {onDevice[t] === undefined ? 'Checking…' : onDevice[t] ? 'On this iPhone' : 'Not available on this iPhone'}
                </span>
              </span>
              {t === current && <span aria-hidden className="text-accent">✓</span>}
            </button>
          </li>
        ))}
      </ul>
    </Screen>
  )
}
