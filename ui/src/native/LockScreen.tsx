/**
 * Caprock is locked (the approved mockup's screen 7): Face ID, with the
 * iPhone passcode as the fallback. Asks once on its own when it appears;
 * the sessions on the computer keep running behind it.
 */
import { useEffect, useRef, useState } from 'react'
import { CaprockMark } from '@/components/AppIcons'
import { currentMachine } from '@/remote/boot'
import { lockKind, unlock } from './lock'

export default function LockScreen({ onOpen }: { onOpen: () => void }) {
  const [name, setName] = useState('Face ID')
  const [failed, setFailed] = useState(false)
  const asked = useRef(false)
  const ask = async () => {
    setFailed(false)
    if (await unlock()) onOpen()
    else setFailed(true)
  }
  useEffect(() => {
    void lockKind().then((k) => setName(k.name))
    if (asked.current) return
    asked.current = true
    void ask()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on appearing
  }, [])
  return (
    <div role="dialog" aria-modal="true" aria-label="Caprock is locked" data-testid="native-lock"
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-bg px-8 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-center">
      <CaprockMark size={44} />
      <h1 className="mb-1.5 mt-5 text-[24px] font-semibold text-fg">Caprock is locked</h1>
      <p className="text-[15px] leading-snug text-fg-muted">You turned on {name} for this app. {currentMachine()?.name ?? 'Your computer'} stays connected; nothing on it stops.</p>
      {failed && <p className="mt-3 text-[15px] text-fg-muted">Not unlocked. Try again.</p>}
      <div className="mt-10 grid w-full max-w-sm gap-1.5">
        <button type="button" onClick={() => void ask()} className="min-h-[52px] w-full rounded-[14px] bg-accent text-[17px] font-semibold text-bg">
          Unlock with {name}
        </button>
        {name !== 'Passcode' && (
          <button type="button" onClick={() => void ask()} className="min-h-11 text-[16px] font-medium text-accent">
            Use passcode
          </button>
        )}
      </div>
    </div>
  )
}
