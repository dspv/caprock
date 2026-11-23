/**
 * Settings → Voice input, in the desktop app on Windows and Linux (ADR-104;
 * the owner-approved mockup, 2026-11-23). The chat's microphone there is
 * whisper.cpp running in the app, and it needs a voice model: this block
 * picks one (*Accurate* or *Fast*), downloads it on a click, shows how far
 * the download is with Cancel, then the installed file with *Show in folder*
 * and *Remove voice model*, or why a download failed with *Try again*.
 *
 * Rule 4: the only outbound call voice input makes is that download, and the
 * line beside its button says what goes and where — one file from
 * huggingface.co (the whisper.cpp project's own models), its SHA-256 checked
 * against hashes built into the app, nothing sent before or after, audio
 * never leaving the computer. The line is kept visible even with the page's
 * explanations hidden.
 *
 * The figures in the models' notes were measured on 2026-11-23 on GitHub's
 * Windows and Linux runners (ADR-104, rule 6). On a Mac, in a browser tab or
 * in an app too old for it, the shell offers no voice model and the block is
 * not drawn: Apple's recogniser needs none (ADR-102).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { refreshDeskVoice } from '@/lib/deskvoice'
import { isTauri } from '@/lib/appmode'
import { shell, type VoiceModelId, type VoiceModelStatus } from '@/lib/shell'
import { Section } from './SettingsParts'
import { VOICE_SECTION } from './Pairing'

/** How often the block asks how far a download is, while one runs. */
export const POLL_MS = 500

const MODEL_TEXT: Record<VoiceModelId, { name: string; note: string }> = {
  small: {
    name: 'Accurate · small',
    note: 'Best for Russian and English. While it listens it uses about 480 MB of memory; a 10–14 second phrase took 3–4 seconds to finish on a 4-thread test machine.',
  },
  base: {
    name: 'Fast · base',
    note: 'About 300 MB of memory and 1–2 seconds to finish the same phrase. Misses more words, often in Russian: about one Russian word in four in our test, against one in twenty for Accurate.',
  },
}

/** Bytes as the block shows them: whole megabytes. */
export function mb(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** Why a download failed, in the block's words. */
export function failureText(error: 'checksum' | 'network' | 'disk', dir?: string): string {
  switch (error) {
    case 'checksum':
      return "The download didn't match its checksum, so it was deleted. Nothing was installed."
    case 'network':
      return 'The download stopped: huggingface.co could not be reached, or the connection broke. Nothing was installed.'
    case 'disk':
      return `The model could not be saved${dir ? ` in ${dir}` : ''} — is the disk full? Nothing was installed.`
  }
}

export function VoiceInputSetting() {
  const [st, setSt] = useState<VoiceModelStatus | null>(null)
  const [pick, setPick] = useState<VoiceModelId | null>(null)
  const [error, setError] = useState('')
  const wasDownloading = useRef(false)
  // Wakes the poll at once: a click that started, cancelled or removed.
  const kickRef = useRef<() => void>(() => {})

  const load = () => shell.voiceModelStatus().then((s) => { setSt(s); return s }, () => null)

  useEffect(() => {
    if (!isTauri()) return
    let live = true
    let timer = 0
    const tick = () => {
      void load().then((s) => {
        if (!live || !s) return
        const downloading = !!s.download
        if (wasDownloading.current && !downloading) refreshDeskVoice()
        wasDownloading.current = downloading
        if (downloading) timer = window.setTimeout(tick, POLL_MS)
      })
    }
    tick()
    kickRef.current = () => { window.clearTimeout(timer); tick() }
    return () => { live = false; window.clearTimeout(timer); kickRef.current = () => {} }
  }, [])

  if (!st?.offered) return null
  const chosen: VoiceModelId = pick ?? st.installed ?? st.download?.model ?? st.error?.model ?? 'small'
  const info = (id: VoiceModelId) => st.models.find((m) => m.id === id)
  const size = mb(info(chosen)?.bytes ?? 0)

  const run = async (f: () => Promise<void>) => {
    setError('')
    try {
      await f()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    refreshDeskVoice()
    kickRef.current()
  }
  const download = () => run(() => shell.voiceModelDownload(chosen))
  const cancel = () => run(() => shell.voiceModelCancel())
  const remove = () => run(async () => { await shell.voiceModelRemove(); setPick(null) })
  const reveal = () => { void shell.voiceModelReveal().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) }

  const where = (
    <p data-help data-keep className="text-[13px] leading-normal text-fg-muted" data-voice-download-note>
      Downloads once from huggingface.co (the whisper.cpp project&apos;s own models, with a 0.9 MB speech detector) and checks
      its SHA-256 against the app&apos;s own copy. Nothing else is sent, before or after, and your voice never leaves this
      computer.
    </p>
  )

  let file: ReactNode
  if (!st.cpu_ok) {
    file = <p className="text-[14px] text-danger">This computer&apos;s processor lacks AVX2, which the voice model needs, so voice input is off here.</p>
  } else if (st.download) {
    const { done, total } = st.download
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
    file = (
      <div className="grid gap-2" data-voice-model-state="downloading">
        <div className="flex flex-wrap items-center gap-3">
          <div className="h-2 min-w-[160px] flex-1 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-label="Voice model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-[13px] tabular-nums text-fg-muted">{Math.round(done / 1_000_000)} of {mb(total)}</span>
          <button type="button" onClick={() => void cancel()} className="min-h-9 rounded-[7px] border border-border-strong px-3 text-[14px] text-fg hover:border-accent">Cancel</button>
        </div>
        <p data-keep className="text-[13px] text-fg-muted">Downloading from huggingface.co. You can keep working; the mic turns on when it is done.</p>
      </div>
    )
  } else if (st.installed && st.installed === chosen) {
    file = (
      <div className="grid gap-2" data-voice-model-state="installed">
        <p className="text-[14.5px] text-fg"><span className="text-ok">✓</span> Installed · {st.installed} · {mb(info(st.installed)?.bytes ?? 0)} · checksum verified</p>
        {st.path && <p data-keep className="break-all font-mono text-[12.5px] text-fg-muted">{st.path}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={reveal} className="min-h-9 rounded-[7px] border border-border-strong px-3 text-[14px] text-fg hover:border-accent">Show in folder</button>
          <button type="button" onClick={() => void remove()} className="min-h-9 rounded-[7px] border border-border-strong px-3 text-[14px] text-danger hover:border-danger">Remove voice model</button>
        </div>
      </div>
    )
  } else {
    const failed = st.error && st.error.model === chosen ? st.error : undefined
    const replaces = st.installed ? ` (replaces ${st.installed})` : ''
    file = (
      <div className="grid gap-2" data-voice-model-state={failed ? 'error' : 'none'}>
        {failed && <p className="text-[14px] text-danger" role="alert">{failureText(failed.error, st.dir)}</p>}
        <div>
          <button type="button" onClick={() => void download()} className="min-h-10 rounded-[8px] bg-accent px-4 text-[15px] font-medium text-panel hover:opacity-90">
            {failed ? 'Try again' : 'Download voice model'} · {size}{replaces}
          </button>
        </div>
        {where}
      </div>
    )
  }

  return (
    <Section id={VOICE_SECTION} title="Voice input">
      <p className="text-[14px] text-fg-muted">
        Speak into the chat and the composer. Recognised on this computer by whisper.cpp; nothing is recorded or sent.
      </p>
      <div className="grid gap-2" role="radiogroup" aria-label="Voice model">
        <span className="text-[15.5px] font-medium text-fg">Voice model</span>
        {st.models.map((m) => {
          const on = m.id === chosen
          return (
            <button key={m.id} type="button" role="radio" aria-checked={on} disabled={!!st.download}
              onClick={() => setPick(m.id)}
              className={`grid gap-0.5 rounded-[10px] border px-3.5 py-2.5 text-left disabled:opacity-60 ${on ? 'border-accent bg-accent/5' : 'border-border hover:border-border-strong'}`}>
              <span className="flex flex-wrap items-center gap-2 text-[15px] font-medium text-fg">
                {MODEL_TEXT[m.id].name}, {mb(m.bytes)}
                {m.id === 'small' && <span className="rounded-full border border-accent px-2 text-[11.5px] font-medium text-accent">Recommended</span>}
                {st.installed === m.id && <span className="text-[12.5px] font-normal text-fg-muted">installed</span>}
              </span>
              <span className="text-[13px] leading-normal text-fg-muted">{MODEL_TEXT[m.id].note}</span>
            </button>
          )
        })}
        <p data-help className="text-[12px] text-fg-faint">
          Measured on 2026-11-23 on GitHub&apos;s Windows and Linux test machines (AMD EPYC, 2 cores, 4 threads) with recorded
          voices; a laptop microphone and a real voice will miss more.
        </p>
      </div>
      <div className="grid gap-2">
        <span className="text-[15.5px] font-medium text-fg">Model file</span>
        {file}
        {error && <p className="text-[13px] text-danger">{error}</p>}
      </div>
      <p className="text-[14px] text-fg-muted">
        <span className="font-medium text-fg">Listens for</span> the language on the chip beside the mic in the chat, as on a Mac.
        {' '}<span className="font-medium text-fg">Microphone:</span> the system&apos;s default.
      </p>
    </Section>
  )
}
