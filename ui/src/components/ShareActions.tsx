/**
 * The ways a share card leaves the sheet — one component for every card
 * (.ai/04-ui.md § Share): the dashboard's figures and story cards
 * (Share.tsx) and the Pipeline's (PipelineShare.tsx).
 *
 *  - **Share…** — the operating system's share sheet with the file, where
 *    the browser has the Web Share API with files.
 *  - **Copy image** — the clipboard (the app's own clipboard command in the
 *    desktop app, `ClipboardItem` image/png in a browser).
 *  - **Save image** — a download: the browser's downloads folder, or in the
 *    app the save dialog its download handler opens.
 *  - **Post** — the words, editable, and **Post to X** / **Post to LinkedIn**,
 *    which open the site with the text written. Neither site can be handed
 *    an image by URL, so the card goes on the clipboard first (or into the
 *    downloads when copying is refused) and the note says to paste or drag
 *    it in — a button that appears to post an image and does not would be a
 *    lie.
 *  - **Telegram** — **To me** sends the card with the words as its caption
 *    to the owner's own paired chat (POST /v1/telegram/photo), only when a
 *    bot and a chat are set up and only on this click; otherwise it says
 *    where to connect one. **To someone else** copies the card and opens
 *    Telegram's share link with the words, to pick the chat and paste.
 *
 * Nothing leaves before a button is pressed, and the caller decides what the
 * card and the words contain (the Pipeline's are anonymous by default).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api, errText, type TelegramStatus } from '@/lib/api'
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

/** Telegram's own share link: pick a chat, the words and the site written. */
export function telegramShareURL(text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent('https://caprock.dev')}&text=${encodeURIComponent(text)}`
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

export function ShareActions({ build, fileName, text, onText, link, disabled, onShared, disclosure }: ShareActionsProps) {
  // `drawing` is the label ("Drawing the card…"); `locked` outlasts it while
  // the OS share sheet is open, so a second click cannot draw a second card.
  const [drawing, setDrawing] = useState(false)
  const [locked, setLocked] = useState(false)
  const [note, setNote] = useState('')
  const [tg, setTg] = useState<TelegramStatus | undefined>(undefined)
  useEffect(() => {
    let live = true
    api.telegram().then((s) => { if (live) setTg(s) }).catch(() => { /* no bridge: To me says where to connect */ })
    return () => { live = false }
  }, [])
  const tgReady = !!tg?.bot_set && !!tg?.chat_set

  /** Draw, run `then` with the card, and say what happened. */
  const act = async (then: (blob: Blob) => Promise<string>, fail: string) => {
    if (locked) return
    setLocked(true); setDrawing(true); setNote('')
    try {
      const blob = await build()
      setDrawing(false)
      if (!blob) { setNote('Could not draw the card in this browser.'); return }
      setNote(await then(blob))
    } catch {
      setNote(fail)
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
    setLocked(true); setDrawing(true); setNote('')
    try {
      const blob = await build()
      if (!blob) { setNote('Could not draw the card in this browser.'); setLocked(false); return }
      setDrawing(false)
      // The file travels alone: several apps take {files, text} as two
      // items, and the owner got the card twice from macOS Copy.
      await navigator.share({ files: [new File([blob], fileName(), { type: 'image/png' })] })
      setLocked(false)
      onShared?.()
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setNote('Sharing was not available — the card was not sent.')
      setLocked(false)
    } finally { setDrawing(false) }
  }

  const copy = () => act(async (b) => (await copyImage(b) ? 'Copied — paste it anywhere.' : 'This browser would not copy an image. Save the image instead.'),
    'Could not read the figures — nothing was copied.')
  const save = () => act(async (b) => { download(b, fileName()); return 'Saved to your downloads.' }, 'Could not read the figures — nothing was saved.')
  const post = (site: 'X' | 'LinkedIn') => act(async (b) => {
    const how = await handOver(b)
    openExternal(site === 'X' ? xPostURL(text, link) : linkedInPostURL(text, link))
    return how === 'copied'
      ? `Opened ${site} with the text — the card is on your clipboard, paste it in.`
      : `Opened ${site} with the text — the card is in your downloads, drag it in.`
  }, 'Could not read the figures — nothing was posted.')
  const toMe = () => act(async (b) => {
    try {
      await api.telegramPhoto(await blobBase64(b), text)
      return `Sent to your Telegram${tg?.chat_name ? ` (${tg.chat_name})` : ''}.`
    } catch (e) {
      return `Telegram did not take it: ${errText(e)}`
    }
  }, 'Could not read the figures — nothing was sent.')
  const toSomeone = () => act(async (b) => {
    const how = await handOver(b)
    openExternal(telegramShareURL(text))
    return how === 'copied'
      ? 'Opened Telegram — pick the chat, then paste the card from your clipboard.'
      : 'Opened Telegram — pick the chat, then drag the card in from your downloads.'
  }, 'Could not read the figures — nothing was sent.')

  const canNative = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [new File([], 'x.png', { type: 'image/png' })] })
  const off = locked || !!disabled
  const quiet = 'rounded-md border border-border px-3 py-2 text-[13px] text-fg transition-colors hover:border-border-strong hover:bg-panel-2 disabled:opacity-50'
  const primary = 'rounded-md bg-accent px-4 py-2.5 text-[14px] font-semibold text-bg transition hover:brightness-110 disabled:opacity-50'
  const head = 'mb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted'

  return (
    <div data-share-actions>
      {disclosure}
      <div className="flex flex-wrap items-stretch gap-2">
        {canNative ? (
          <button onClick={shareNative} disabled={off} className={`${primary} min-w-[180px] flex-1`} title="Opens your share menu — Messages, Mail, anywhere">
            {drawing ? 'Drawing the card…' : 'Share…'}
          </button>
        ) : (
          <button onClick={copy} disabled={off} className={`${primary} min-w-[180px] flex-1`} title="Puts the picture on your clipboard, to paste into a post or a chat">
            {drawing ? 'Drawing the card…' : 'Copy image'}
          </button>
        )}
        {canNative && <button onClick={copy} disabled={off} className={quiet}>Copy image</button>}
        <button onClick={save} disabled={off} className={quiet} title="A PNG in your downloads">Save image</button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className={head}>Post</div>
          <textarea value={text} onChange={(e) => onText(e.target.value)} rows={2} aria-label="The words to post with the card"
            className="w-full resize-y rounded-md border border-border bg-panel-2 px-2.5 py-2 text-[13px] text-fg outline-none focus:border-accent/60" />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button onClick={() => void post('X')} disabled={off} className={quiet} title="Opens a post on X with the text; the card goes on your clipboard to paste in">Post to X</button>
            <button onClick={() => void post('LinkedIn')} disabled={off} className={quiet} title="Opens a LinkedIn post with the text; the card goes on your clipboard to paste in">Post to LinkedIn</button>
            <span className="text-[12px] text-fg-faint">The site gets the text; attach the card from your clipboard.</span>
          </div>
        </div>
        <div className="min-w-0">
          <div className={head}>Telegram</div>
          <div className="flex flex-wrap items-center gap-2">
            {tgReady ? (
              <button onClick={() => void toMe()} disabled={off} className={quiet}
                title={`Your own bot sends the card, with the text as its caption, to ${tg?.chat_name ?? 'your paired chat'}`}>To me</button>
            ) : (
              <button type="button" onClick={() => navigate({ name: 'settings', section: 'telegram' })} className="px-1 text-[13px] text-accent hover:underline"
                title="To me sends through your own bot, once one is connected and a chat paired">Connect Telegram in Settings</button>
            )}
            <button onClick={() => void toSomeone()} disabled={off} className={quiet} title="Copies the card and opens Telegram's share link with the text, to pick a chat and paste">To someone else</button>
          </div>
        </div>
      </div>
      {note && <p className="mt-2 text-[12px] text-fg-muted" role="status">{note}</p>}
    </div>
  )
}
