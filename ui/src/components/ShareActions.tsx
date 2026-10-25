/**
 * The ways a share card leaves the sheet — one component for every card
 * (.ai/04-ui.md § Share): the dashboard's card (Share.tsx) and the
 * Pipeline's (PipelineShare.tsx).
 *
 * Two rows of buttons and nothing else on screen (owner, 2026-10-25: the
 * sheet was "visual chaos" — a sentence beside every row and a paragraph for
 * every result). What each button does is in its tooltip; what just happened
 * shows for a few seconds beside the first row.
 *
 *  - **Share…, Copy image, Save image** — the operating system's share sheet
 *    with the file (where the browser has the Web Share API with files), the
 *    clipboard (the app's own clipboard command in the desktop app), and a
 *    download (in the app, its save dialog).
 *  - **My Telegram, X, Threads, LinkedIn** — the destinations. My Telegram sends the
 *    card with the words as its caption through the person's own bot to
 *    their own paired chat (POST /v1/telegram/photo), only on this click;
 *    with no bot or chat it is **Set up Telegram**, a way to Settings. X, Threads and
 *    LinkedIn open a post with the words written; neither can be handed an
 *    image by URL, so the card goes on the clipboard first (or into the
 *    downloads when copying is refused) and the result says to paste it.
 *    Sending to someone else in Telegram was a button that only copied the
 *    card and opened a chat picker: Copy image does the copying.
 *  - **Edit post text** — the words, folded away until asked for.
 *
 * Nothing leaves before a button is pressed, and the caller decides what the
 * card and the words contain (the Pipeline's are anonymous by default).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errText, type TelegramStatus } from '@/lib/api'
import { isMacPlatform } from '@/lib/appmode'
import { copyImage } from '@/lib/attachments'
import { openExternal } from '@/lib/nudges'
import { navigate } from '@/lib/router'

export interface ShareActionsProps {
  /** The image that leaves, drawn from the current figures. */
  build: () => Promise<Blob | null>
  fileName: () => string
  /** The words that go with it: the post's text and the Telegram caption. */
  text: string
  onText: (t: string) => void
  /** A link the post carries beside the text (X's `url`); omitted when the text names the site itself. */
  link?: string
  /** Nothing to share yet. */
  disabled?: boolean
  /** After the operating system's share sheet sent it. */
  onShared?: () => void
  /** Said above the buttons: what the card shows that is the person's own (the Pipeline's repository line). */
  disclosure?: ReactNode
}

/** X's post page with the words written. */
export function xPostURL(text: string, link?: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}${link ? `&url=${encodeURIComponent(link)}` : ''}`
}

/** LinkedIn's post box with the words written. */
export function linkedInPostURL(text: string, link?: string): string {
  return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(link ? `${text} ${link}` : text)}`
}

/**
 * Threads' post box with the words written. threads.com is the address
 * threads.net now redirects to (checked 2026-10-25); the link rides in the
 * text, as on LinkedIn.
 */
export function threadsPostURL(text: string, link?: string): string {
  return `https://www.threads.com/intent/post?text=${encodeURIComponent(link ? `${text} ${link}` : text)}`
}

/** A blob as base64, for the JSON body POST /v1/telegram/photo takes. */
export async function blobBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** How long a result stays beside the buttons. */
const NOTE_MS = 6000

export function ShareActions({ build, fileName, text, onText, link, disabled, onShared, disclosure }: ShareActionsProps) {
  // `drawing` is the label ("Drawing…"); `locked` outlasts it while the OS
  // share sheet is open, so a second click cannot draw a second card.
  const [drawing, setDrawing] = useState(false)
  const [locked, setLocked] = useState(false)
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)
  // After X, Threads or LinkedIn opened: the one step left, said large until
  // the next action — a web post box cannot be handed a picture, only words.
  const [paste, setPaste] = useState<{ site: string; how: 'copied' | 'saved' } | undefined>(undefined)
  // The paste key is the browser's, not the app's: keys() would say the
  // terminal's Ctrl+Shift+V off macOS, and the post box is a web page.
  const [tg, setTg] = useState<TelegramStatus | undefined>(undefined)
  useEffect(() => {
    let live = true
    api.telegram().then((s) => { if (live) setTg(s) }).catch(() => { /* no bridge: Set up Telegram */ })
    return () => { live = false }
  }, [])
  const tgReady = !!tg?.bot_set && !!tg?.chat_set

  // A result is said briefly, then the row is quiet again.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const say = (s: string) => {
    setNote(s)
    if (timer.current) clearTimeout(timer.current)
    if (s) timer.current = setTimeout(() => setNote(''), NOTE_MS)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  /** Draw, run `then` with the card, and say what happened. */
  const act = async (then: (blob: Blob) => Promise<string>, fail: string) => {
    if (locked) return
    setLocked(true); setDrawing(true); say(''); setPaste(undefined)
    try {
      const blob = await build()
      setDrawing(false)
      if (!blob) { say('Could not draw the card here.'); return }
      say(await then(blob))
    } catch {
      say(fail)
    } finally { setDrawing(false); setLocked(false) }
  }

  /** The card on the clipboard, else in the downloads: where a paste or a drag finds it. */
  const handOver = async (blob: Blob): Promise<'copied' | 'saved'> => {
    if (await copyImage(blob)) return 'copied'
    download(blob, fileName())
    return 'saved'
  }

  const shareNative = async () => {
    if (locked) return
    setLocked(true); setDrawing(true); say('')
    try {
      const blob = await build()
      if (!blob) { say('Could not draw the card here.'); setLocked(false); return }
      setDrawing(false)
      // The file travels alone: several apps take {files, text} as two
      // items, and the owner got the card twice from macOS Copy.
      await navigator.share({ files: [new File([blob], fileName(), { type: 'image/png' })] })
      setLocked(false)
      onShared?.()
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') say('Sharing was not available — nothing was sent.')
      setLocked(false)
    } finally { setDrawing(false) }
  }

  const copy = () => act(async (b) => (await copyImage(b) ? 'Copied — paste it anywhere.' : 'Copying was refused — use Save image.'),
    'Could not read the figures — nothing was copied.')
  const save = () => act(async (b) => { download(b, fileName()); return 'Saved to your downloads.' }, 'Could not read the figures — nothing was saved.')
  const post = (site: 'X' | 'Threads' | 'LinkedIn') => act(async (b) => {
    const how = await handOver(b)
    openExternal(site === 'X' ? xPostURL(text, link) : site === 'Threads' ? threadsPostURL(text, link) : linkedInPostURL(text, link))
    setPaste({ site, how })
    return ''
  }, 'Could not read the figures — nothing was posted.')
  const toMe = () => act(async (b) => {
    try {
      await api.telegramPhoto(await blobBase64(b), text)
      return `Sent to your Telegram${tg?.chat_name ? ` (${tg.chat_name})` : ''}.`
    } catch (e) {
      return `Telegram did not take it: ${errText(e)}`
    }
  }, 'Could not read the figures — nothing was sent.')

  const canNative = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [new File([], 'x.png', { type: 'image/png' })] })
  const off = locked || !!disabled
  const quiet = 'inline-flex items-center rounded-md border border-border px-3 py-1.5 text-[13px] text-fg transition-colors hover:border-border-strong hover:bg-panel-2 disabled:opacity-50'
  const primary = 'inline-flex items-center rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-bg transition hover:brightness-110 disabled:opacity-50'
  const busy = 'Drawing…'

  return (
    <div data-share-actions>
      {disclosure}
      <div className="flex flex-wrap items-center gap-2">
        {canNative && (
          <button onClick={shareNative} disabled={off} className={primary} title="Opens your share menu — Messages, Mail, AirDrop, anywhere">
            {drawing ? busy : 'Share…'}
          </button>
        )}
        <button onClick={copy} disabled={off} className={canNative ? quiet : primary} title="Puts the picture on your clipboard, to paste into a post or a chat">
          {drawing && !canNative ? busy : 'Copy image'}
        </button>
        <button onClick={save} disabled={off} className={quiet} title="Saves the picture as a PNG in your downloads">Save image</button>
        <span className="min-w-0 text-[12px] text-fg-muted" role="status" aria-live="polite">{note}</span>
      </div>

      <div data-share-destinations className="mt-2 flex flex-wrap items-center gap-2">
        {tgReady ? (
          <button onClick={() => void toMe()} disabled={off} className={quiet} aria-label="Send to my Telegram"
            title={`Your own bot sends the card, with the post text as its caption, to your own chat${tg?.chat_name ? ` (${tg.chat_name})` : ''}. Nothing goes anywhere else.`}>
            <TelegramMark />My Telegram
          </button>
        ) : (
          <button type="button" onClick={() => navigate({ name: 'settings', section: 'telegram' })} className={quiet}
            title="Connect your own Telegram bot in Settings, then the card goes from it to your own chat">
            <TelegramMark />Set up Telegram
          </button>
        )}
        <button onClick={() => void post('X')} disabled={off} className={quiet} aria-label="Post to X"
          title="Opens a post on X with the post text; this card goes on your clipboard — paste it into the post">X</button>
        <button onClick={() => void post('Threads')} disabled={off} className={quiet} aria-label="Post to Threads"
          title="Opens a Threads post with the post text; this card goes on your clipboard — paste it into the post">Threads</button>
        <button onClick={() => void post('LinkedIn')} disabled={off} className={quiet} aria-label="Post to LinkedIn"
          title="Opens a LinkedIn post with the post text; this card goes on your clipboard — paste it into the post">LinkedIn</button>
        <button type="button" onClick={() => setEditing((v) => !v)} aria-expanded={editing}
          className="ml-auto text-[12px] text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          title="The words that go with X, LinkedIn and the Telegram caption">
          {editing ? 'Hide post text' : 'Edit post text'}
        </button>
      </div>

      {paste && <PasteSteps site={paste.site} how={paste.how} />}

      {editing && (
        <textarea value={text} onChange={(e) => onText(e.target.value)} rows={2} aria-label="The words to post with the card"
          className="mt-2 w-full resize-y rounded-md border border-border bg-panel-2 px-2.5 py-2 text-[13px] text-fg outline-none focus:border-accent/60" />
      )}
    </div>
  )
}

/**
 * What is left after X, Threads or LinkedIn opened, as numbered steps (owner,
 * 2026-10-25: he expected the card in the post and did not know to paste it).
 * Two steps are done; the third is the person's, said largest.
 */
function PasteSteps({ site, how }: { site: string; how: 'copied' | 'saved' }) {
  const done = 'flex gap-2 text-[13px] text-fg-muted'
  return (
    <div role="status" data-share-paste className="mt-3 rounded-md border border-accent/50 bg-accent/10 px-3 py-2.5">
      <ol className="grid gap-1">
        <li className={done}><span aria-hidden className="text-accent">✓</span>
          {how === 'copied' ? 'This card is on your clipboard.' : 'This card is in your downloads.'}</li>
        <li className={done}><span aria-hidden className="text-accent">✓</span>A {site} post is open with the words written.</li>
        <li className="flex gap-2 text-[14px] font-medium text-fg"><span aria-hidden className="text-accent">3</span>
          {how === 'copied'
            ? `In the ${site} post, click the text and press ${isMacPlatform() ? '⌘V' : 'Ctrl+V'}: the card appears. Then post.`
            : `Drag the card from your downloads into the ${site} post. Then post.`}</li>
      </ol>
      <p className="mt-1.5 text-[12px] text-fg-faint">{site} takes only words from a link, so the picture goes in by hand.</p>
    </div>
  )
}

/** Telegram's paper plane, so the button reads as Telegram before its words do. */
function TelegramMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden className="mr-1.5 inline-block -mt-px align-middle text-fg-muted" fill="currentColor">
      <path d="M21.9 4.3 18.7 19.4c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13.1l-4.8-1.5c-1-.3-1.1-1 .2-1.5L20.5 2.9c.9-.3 1.6.2 1.4 1.4z" />
    </svg>
  )
}
