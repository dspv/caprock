import { useRef, useState } from 'react'

/** A newline inside the prompt: ESC CR, what a terminal sends for Alt+Enter
 *  (see Terminal.tsx — a bare line feed submits once text is typed). */
const NEWLINE = '\x1b\r'

/** How long to wait between the text and the Enter that submits it. Sent in
 *  one write, a TUI reads the pair as a paste and keeps the Enter as a line. */
const SUBMIT_DELAY_MS = 80

const KEYS: [label: string, bytes: string, title: string][] = [
  ['Esc', '\x1b', 'Escape — close a menu, interrupt Claude Code'],
  ['Tab', '\t', 'Tab — complete, switch mode'],
  ['↑', '\x1b[A', 'Up — previous prompt, move in a menu'],
  ['↓', '\x1b[B', 'Down — move in a menu'],
  ['⏎', '\r', 'Enter — choose in a menu, submit'],
  ['Ctrl+C', '\x03', 'Ctrl+C — interrupt'],
]

/**
 * Typing into a session from a phone.
 *
 * A phone's keyboard has no Esc, Tab, arrows or Ctrl, and Claude Code's menus
 * — the permission prompt above all — are answered with exactly those. So the
 * keys are buttons, and the text goes in a field big enough to read what is
 * being sent before sending it, rather than letter by letter into a canvas.
 */
export function TerminalKeys({ send, attach }: { send: (bytes: string) => void; attach?: (files: File[]) => Promise<void> }) {
  const [text, setText] = useState('')
  const [attaching, setAttaching] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  // The picked photos' paths are typed into the session, as a drop's are;
  // what to say about them goes in the field and is sent after.
  const onPicked = async (files: File[]) => {
    if (!attach || files.length === 0) return
    setAttaching(true)
    try {
      await attach(files)
    } finally {
      setAttaching(false)
      if (picker.current) picker.current.value = ''
    }
  }

  const submit = () => {
    if (text) {
      send(text.replace(/\r?\n/g, NEWLINE))
      window.setTimeout(() => send('\r'), SUBMIT_DELAY_MS)
    } else {
      send('\r')
    }
    setText('')
    field.current?.focus()
  }

  return (
    <div className="grid gap-2 border-t border-border px-2 py-2">
      <div className="flex items-end gap-2">
        {/* 16px: iOS zooms the page into any field set smaller, and the
          * terminal above would be cut off when it did. Inline, because
          * .input's own 12px outranked the text-[16px] utility. */}
        <textarea
          ref={field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={2}
          placeholder="Type to the session…"
          aria-label="Type to the session"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="input min-w-0 flex-1 resize-none leading-snug"
          style={{ fontSize: 16 }}
        />
        {attach && (
          <>
            {/* No `capture`: with it iOS opens only the camera; without it the
              * picker offers Take Photo and the photo library both. */}
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              aria-hidden="true"
              tabIndex={-1}
              data-testid="photo-picker"
              onChange={(e) => void onPicked([...(e.target.files ?? [])])}
            />
            <button
              type="button"
              disabled={attaching}
              onClick={() => picker.current?.click()}
              title="Attach a photo from the camera or the library"
              aria-label="Attach a photo"
              className="shrink-0 rounded-sm border border-border-strong bg-panel-2 px-3 py-2 min-h-[44px] text-[14px] text-fg hover:border-accent disabled:opacity-50"
            >
              {attaching ? 'Adding…' : 'Photo'}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={submit}
          className="shrink-0 rounded-sm bg-accent px-4 py-2 min-h-[44px] text-[14px] font-medium text-bg hover:brightness-110"
        >
          Send
        </button>
      </div>
      <div className="grid grid-cols-6 gap-1.5">
        {KEYS.map(([label, bytes, title]) => (
          <button
            key={label}
            type="button"
            title={title}
            aria-label={title}
            // Keep the field focused, so the keyboard does not drop and rise
            // between a key and the next word.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => send(bytes)}
            className="min-h-[44px] min-w-0 rounded-sm border border-border-strong bg-panel-2 px-1 text-[13px] mono text-fg hover:border-accent active:bg-accent/15"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
