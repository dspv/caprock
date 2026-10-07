/**
 * The desktop app's one question about updates (F20), on its first launch:
 * "Check for updates automatically?", Yes highlighted. It is the release
 * check that already exists (Settings → Privacy, `update_checks`), asked in
 * the app instead of in a banner, and never an OS dialog. Answered once
 * either way; with checks already on it is not asked at all.
 */
import { useEffect, useRef } from 'react'
import { appUpdate, useAppUpdate } from '@/lib/appupdate'
import { usePlan } from './PlanPicker'

export function AppUpdateAsk() {
  const info = useAppUpdate()
  const [plan, savePlan] = usePlan()
  const yes = useRef<HTMLButtonElement>(null)
  const pending = !!info && !info.asked && !!plan
  const alreadyOn = pending && plan.update_checks

  useEffect(() => {
    if (alreadyOn) void appUpdate.asked()
  }, [alreadyOn])
  useEffect(() => {
    if (pending && !alreadyOn) yes.current?.focus({ preventScroll: true })
  }, [pending, alreadyOn])

  if (!pending || alreadyOn) return null
  const answer = (on: boolean) => {
    // Switching it on makes the daemon check at once (settingsAdapter.Set).
    if (on) savePlan({ update_checks: true })
    void appUpdate.asked()
  }
  return (
    <div
      role="dialog"
      aria-label="Check for updates automatically?"
      className="app-fade-in fixed bottom-10 right-4 z-50 grid w-[340px] max-w-[calc(100vw-32px)] gap-2.5 rounded-[10px] border border-[var(--app-hairline-strong)] bg-panel p-3.5 text-[12.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
    >
      <p className="font-medium">Check for updates automatically?</p>
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Every few hours Caprock asks GitHub for the newest version number. Nothing about you or your work is sent,
        and nothing installs until you click Update. Change it any time in Settings → Privacy.
      </p>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => answer(false)}
          className="rounded-[6px] border border-[var(--app-hairline-strong)] px-2.5 py-1 text-[12px] text-fg-muted hover:text-fg"
        >
          No
        </button>
        <button
          ref={yes}
          type="button"
          onClick={() => answer(true)}
          className="rounded-[6px] bg-accent px-3 py-1 text-[12px] font-medium text-bg hover:brightness-110"
        >
          Yes
        </button>
      </div>
    </div>
  )
}
