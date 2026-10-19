/**
 * The chat view's acceptance (WP-14) as far as jsdom can show it: order from
 * the server through the live socket, each message once, the scrolling rule
 * while messages stream in and while an older page is revealed, and the open
 * time of a long session. jsdom does no layout, so every row of the log is
 * given a fixed height and the log a real scrollTop — the hook only reads
 * geometry, so this is the arithmetic a browser would hand it. The pixel
 * measurements in a real browser are in the PR.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@/lib/api'
import { live } from '@/lib/live'
import type { LinkPhase } from '@/lib/reconnect'
import { ChatView, CHAT_GAP_PAGES, CHAT_PAGE_EVENTS, CHAT_WINDOW } from './ChatView'
import { resetPickerCache } from './ChatPicker'

const store = vi.hoisted(() => ({
  events: [] as Event[], inputs: [] as string[], before: 0, prompt: false, busy: false,
  queued: [] as { id: number; session_id: string; text: string; created_at: number; updated_at: number }[],
  calls: [] as string[],
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  const order = (a: Event, b: Event) => Date.parse(a.ts) - Date.parse(b.ts) || a.id - b.id
  return {
    ...actual,
    api: {
      ...actual.api,
      recentEvents: async (_id: string, limit: number) => store.events.slice().sort(order).slice(-limit),
      eventsBefore: async (_id: string, before: number, limit: number) => {
        store.before++
        const all = store.events.slice().sort(order)
        const at = all.findIndex((e) => e.id === before)
        return all.slice(Math.max(0, at - limit), at)
      },
      agentInput: async (_id: string, data: string) => { store.inputs.push(data) },
      // The daemon types each path as the desktop terminal does (xtermInput
      // pathInput), in a session that asked for bracketed paste.
      agentPaths: async (_id: string, paths: readonly string[]) => {
        const { pathInput } = await import('@/lib/xtermInput')
        for (const p of paths) store.inputs.push(pathInput(p, true))
      },
      permission: async () => ({ permission: store.prompt ? { id: 'p', tool: 'Bash', detail: 'ls', since: '' } : null }),
      paste: async (f: { name: string }) => ({ path: `/data/paste/${f.name}` }),
      // The daemon's queue (ADR-053): typed at once at the prompt, held mid-turn
      // or while a prompt waits.
      queue: async (id: string) => view(id),
      queueSend: async (id: string, text: string) => {
        if (!store.busy && !store.prompt && store.queued.length === 0) {
          store.inputs.push(text, '\r')
          return { sent: true, queue: view(id) }
        }
        const m = { id: store.queued.length + 100, session_id: id, text, created_at: 0, updated_at: 0 }
        store.queued.push(m)
        return { sent: false, queued: m, queue: view(id) }
      },
      queueEdit: async (id: string, qid: number, text: string) => {
        store.calls.push(`edit ${qid} ${text}`)
        store.queued = store.queued.map((m) => (m.id === qid ? { ...m, text } : m))
        return view(id)
      },
      queueCancel: async (id: string, qid: number) => {
        store.calls.push(`cancel ${qid}`)
        store.queued = store.queued.filter((m) => m.id !== qid)
        return view(id)
      },
      queueSendNow: async (id: string, qid: number) => {
        store.calls.push(`now ${qid}`)
        const m = store.queued.find((x) => x.id === qid)
        store.queued = store.queued.filter((x) => x.id !== qid)
        if (m) store.inputs.push(m.text, '\r')
        return view(id)
      },
      sessionCommands: async () => ({ agent: 'claude', commands: [
        { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
        { name: 'compact', description: 'Compact the conversation', source: 'builtin' },
        { name: 'ship', description: 'Ship it', source: 'project' },
      ] }),
      sessionFiles: async () => ({ files: ['README.md', 'src/main.go', 'src/queue.go', 'ui/src/App.tsx'] }),
    },
  }
})

function view(id: string) {
  return { session_id: id, messages: store.queued.slice(), waiting: store.prompt ? 'permission' : store.busy ? 'turn' : '' }
}

const BASE = Date.UTC(2026, 9, 5, 12, 0, 0)
const ROW = 20
const VIEW = 400

function msg(id: number, text = `message ${id}`): Event {
  return { id, ts: new Date(BASE + id * 1000).toISOString(), session_id: 's', source: 'hook', kind: 'turn.user', payload: { prompt: text } }
}

function shuffle<T>(xs: T[], seed = 11): T[] {
  const out = xs.slice()
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const scrollTops = new WeakMap<Element, number>()
const isLog = (el: Element) => el.getAttribute('role') === 'log'
/** What CSS would give a row: none for one styled `h-0`, a fixed height otherwise. */
const heightOf = (el: Element) => (el.classList.contains('h-0') ? 0 : ROW)
const contentHeight = (el: Element) => Array.from(el.children).reduce((y, c) => y + heightOf(c), 0)
const realRect = Element.prototype.getBoundingClientRect
const GEOMETRY = ['clientHeight', 'scrollHeight', 'scrollTop'] as const
const originals = GEOMETRY.map((k) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, k))

// The live store must not open a socket of its own here. It did: the first
// render subscribed, jsdom dialled ws://localhost:3000/v1/live, nothing
// answered, and the close set the phase to "reconnecting" whenever it landed —
// mid-test on a busy machine, after beforeEach had set it live. A message
// sent in that window was held as "Will send when connected" instead of
// reaching the queue (CI run 38753475630). Each test sets the phase itself
// (setPhase) and delivers frames by hand (live.handle).
vi.spyOn(live, 'start').mockImplementation(() => {})

/** The live socket's state, as the reconnect policy would set it. */
function setPhase(phase: LinkPhase) {
  act(() => { (live as unknown as { set: (p: object) => void }).set({ link: { phase, attempt: 0, nextAt: null, downSince: null } }) })
}

beforeEach(() => {
  store.events = []
  store.inputs = []
  store.before = 0
  store.prompt = false
  store.busy = false
  store.queued = []
  store.calls = []
  resetPickerCache()
  sessionStorage.clear()
  setPhase('live')
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isLog(this) ? VIEW : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return isLog(this) ? contentHeight(this) : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return scrollTops.get(this) ?? 0 },
    set(this: Element, v: number) {
      const max = Math.max(0, contentHeight(this) - VIEW)
      scrollTops.set(this, Math.max(0, Math.min(v, max)))
    },
  })
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const parent = this.parentElement
    if (parent && isLog(parent)) {
      const before = Array.from(parent.children).slice(0, Array.from(parent.children).indexOf(this))
      const top = before.reduce((y, c) => y + heightOf(c), 0) - parent.scrollTop
      const h = heightOf(this)
      return { top, bottom: top + h, height: h, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    }
    return { top: 0, bottom: VIEW, height: VIEW, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
})

afterEach(() => {
  GEOMETRY.forEach((k, i) => {
    const d = originals[i]
    if (d) Object.defineProperty(HTMLElement.prototype, k, d)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]
  })
  Element.prototype.getBoundingClientRect = realRect
})

const log = () => screen.getByRole('log')
const renderedIds = () => Array.from(log().querySelectorAll('[data-msg-id]')).map((el) => Number(el.getAttribute('data-msg-id')))

function firstVisible(): { id: string; top: number } {
  for (const c of Array.from(log().children)) {
    const r = c.getBoundingClientRect()
    if (r.bottom > 0 && c.hasAttribute('data-msg-id')) return { id: c.getAttribute('data-msg-id')!, top: r.top }
  }
  throw new Error('nothing visible')
}

async function deliver(events: Event[]) {
  await act(async () => {
    for (const e of events) live.handle({ type: 'event', data: e })
    await new Promise((r) => setTimeout(r, 40))
  })
}

describe('ChatView', () => {
  it('50 messages out of order and 10 duplicates over the live socket: rendered in server order, each once', async () => {
    render(<ChatView sessionId="s" canType={false} />)
    await screen.findByText('No messages yet')
    const server = Array.from({ length: 50 }, (_, i) => msg(i + 1, `μήνυμα ${i + 1} 日本 🙂`))
    const dupes = shuffle(server, 5).slice(0, 10)
    // Delivered in separate bursts, so later frames land among earlier ones.
    const delivery = shuffle([...server, ...dupes])
    for (let i = 0; i < delivery.length; i += 7) await deliver(delivery.slice(i, i + 7))
    expect(renderedIds()).toEqual(server.map((e) => e.id))
    expect(new Set(renderedIds()).size).toBe(50)
    expect(screen.getByText('μήνυμα 1 日本 🙂')).toBeInTheDocument()
  })

  it('an event replayed after it was fetched, and a late one older than what is shown, land in place', async () => {
    store.events = [1, 2, 3, 5, 6].map((i) => msg(i))
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toEqual([1, 2, 3, 5, 6]))
    await deliver([msg(6), msg(2), msg(4)])
    expect(renderedIds()).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('a reset from the live socket refetches, and what was missed lands in place once', async () => {
    store.events = [1, 2].map((i) => msg(i))
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toEqual([1, 2]))
    store.events = [1, 2, 3, 4].map((i) => msg(i))
    await act(async () => { live.handle({ type: 'reset', data: { seq: 1 } }); await new Promise((r) => setTimeout(r, 20)) })
    await waitFor(() => expect(renderedIds()).toEqual([1, 2, 3, 4]))
    await deliver([msg(3), msg(4)])
    expect(renderedIds()).toEqual([1, 2, 3, 4])
  })

  it('200 messages streamed while scrolled up: the first visible message stays put, and the pill counts them', async () => {
    store.events = Array.from({ length: 100 }, (_, i) => msg(i + 1))
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toHaveLength(100))
    const el = log()
    expect(el.scrollTop).toBe(el.scrollHeight - VIEW)
    act(() => { el.scrollTop = 1000; fireEvent.scroll(el) })
    const before = firstVisible()
    for (let i = 0; i < 200; i += 20) await deliver(Array.from({ length: 20 }, (_, k) => msg(1000 + i + k)))
    const after = firstVisible()
    expect(after.id).toBe(before.id)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
    expect(screen.getByRole('button', { name: /200/ })).toBeInTheDocument()
  })

  it('at the bottom it follows', async () => {
    store.events = Array.from({ length: 50 }, (_, i) => msg(i + 1))
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toHaveLength(50))
    await deliver([msg(500)])
    const el = log()
    expect(el.scrollHeight - el.scrollTop - VIEW).toBeLessThanOrEqual(4)
    expect(screen.queryByRole('button', { name: /new/ })).toBeNull()
  })

  it('an older page revealed at the top keeps the first visible message in place', async () => {
    store.events = Array.from({ length: CHAT_PAGE_EVENTS * 2 }, (_, i) => msg(i + 1))
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toHaveLength(CHAT_WINDOW))
    const el = log()
    // Near the top, the first message partly visible: what a reader sees
    // when the next page is revealed.
    el.scrollTop = 10
    const first = firstVisible()
    act(() => { fireEvent.scroll(el) })
    await waitFor(() => expect(renderedIds().length).toBeGreaterThan(CHAT_WINDOW))
    expect(firstVisible()).toEqual(first)
    // Revealing again past what was fetched asks the daemon for the page before.
    for (let i = 0; i < 6; i++) {
      el.scrollTop = 10
      const before = firstVisible()
      await act(async () => { fireEvent.scroll(el); await new Promise((r) => setTimeout(r, 20)) })
      const after = firstVisible()
      expect(after.id).toBe(before.id)
      expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
    }
    await waitFor(() => expect(renderedIds()[0]).toBe(1))
    expect(screen.getByText('start of session')).toBeInTheDocument()
  })

  it('a 2,000-message session opens in well under 500 ms', async () => {
    store.events = Array.from({ length: 2000 }, (_, i) => msg(i + 1))
    const t0 = performance.now()
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toHaveLength(CHAT_WINDOW))
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it('types into the session: the text, then Enter, in that order', async () => {
    render(<ChatView sessionId="s" canType />)
    const field = screen.getByLabelText('Type to the session')
    fireEvent.change(field, { target: { value: 'καλημέρα' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(store.inputs).toEqual(['καλημέρα', '\r']), { timeout: 1000 })
  })

  it('a reconnect whose newest page misses what is held pages back to it: nothing lost, the reader stays put', async () => {
    store.events = Array.from({ length: CHAT_PAGE_EVENTS }, (_, i) => msg(i + 1))
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toHaveLength(CHAT_WINDOW))
    const el = log()
    act(() => { el.scrollTop = 1000; fireEvent.scroll(el) })
    const before = firstVisible()
    const shownFirst = renderedIds()[0]!
    // 1,200 events arrived while away, more than one page past what is held.
    const total = CHAT_PAGE_EVENTS * 5
    store.events = Array.from({ length: total }, (_, i) => msg(i + 1))
    store.before = 0
    await act(async () => { live.handle({ type: 'reset', data: { seq: 1 } }); await new Promise((r) => setTimeout(r, 40)) })
    await waitFor(() => expect(renderedIds()[renderedIds().length - 1]).toBe(total))
    const ids = renderedIds()
    expect(ids[0]).toBe(shownFirst)
    expect(ids).toEqual(Array.from({ length: total - shownFirst + 1 }, (_, i) => shownFirst + i))
    expect(store.before).toBe(4)
    const after = firstVisible()
    expect(after.id).toBe(before.id)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
    // 1,200 new, which the pill caps at 999+.
    expect(screen.getByRole('button', { name: /999\+/ })).toBeInTheDocument()
  })

  it('a hole wider than the pages it may fetch starts again from the newest page', async () => {
    store.events = Array.from({ length: CHAT_PAGE_EVENTS }, (_, i) => msg(i + 1))
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toHaveLength(CHAT_WINDOW))
    const total = CHAT_PAGE_EVENTS * (CHAT_GAP_PAGES + 3)
    store.events = Array.from({ length: total }, (_, i) => msg(i + 1))
    store.before = 0
    await act(async () => { live.handle({ type: 'reset', data: { seq: 1 } }); await new Promise((r) => setTimeout(r, 40)) })
    await waitFor(() => expect(renderedIds()[0]).toBe(total - CHAT_WINDOW + 1))
    expect(store.before).toBe(CHAT_GAP_PAGES)
    expect(renderedIds()).toHaveLength(CHAT_WINDOW)
  })

  it('a short conversation sits at the bottom, next to the field', async () => {
    store.events = [msg(1), msg(2)]
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toEqual([1, 2]))
    // The flex column and the first row's auto top margin are what push it
    // down in a browser; the measurements at 390, 320 and 1400 px are in the PR.
    expect(log().className).toMatch(/\bflex-col\b/)
    expect(log().firstElementChild!.className).toMatch(/\bmt-auto\b/)
  })

  it('a call its turn cut off says "interrupted"; only the current one says "running"', async () => {
    const call = (id: number, use: string): Event => ({ ...msg(id), source: 'codex' as Event['source'], kind: 'tool.pre', tool: 'exec', payload: { tool_name: 'exec', tool_use_id: use, tool_input: { command: 'await tools.exec_command({cmd:"sleep 60"})' } } })
    store.events = [
      call(1, 'a'),
      { ...msg(2), source: 'codex' as Event['source'], kind: 'tool.post', tool: 'exec', payload: { tool_use_id: 'a', tool_response: '', interrupted: true } },
      msg(3, 'try again'),
      call(4, 'b'),
    ]
    render(<ChatView sessionId="s" canType={false} />)
    await waitFor(() => expect(renderedIds()).toEqual([1, 3, 4]))
    const line = (id: number) => log().querySelector(`[data-msg-id="${id}"]`)!.textContent
    expect(line(1)).toBe('exec  sleep 60interrupted')
    expect(line(4)).toBe('exec  sleep 60running')
  })

  it('offline, a message is held as "will send", and goes when the live socket is back', async () => {
    render(<ChatView sessionId="s" canType />)
    setPhase('reconnecting')
    fireEvent.change(screen.getByLabelText('Type to the session'), { target: { value: 'ciao' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByText('Will send when connected')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 150))
    expect(store.inputs).toEqual([])
    act(() => { live.handle({ type: 'hello', data: { server_time: Date.now() } }) })
    await waitFor(() => expect(store.inputs).toEqual(['ciao', '\r']), { timeout: 1000 })
    expect(screen.queryByText('Will send when connected')).toBeNull()
  })

  it('offline, a raw key is refused, never queued', () => {
    render(<ChatView sessionId="s" canType />)
    setPhase('reconnecting')
    fireEvent.click(screen.getByRole('button', { name: /^Escape/ }))
    expect(screen.getByText(/Esc was not sent/)).toBeInTheDocument()
    expect(store.inputs).toEqual([])
  })

  it('back with a permission prompt waiting, the held message goes to the queue, never into the prompt', async () => {
    store.prompt = true
    render(<ChatView sessionId="s" canType />)
    setPhase('reconnecting')
    fireEvent.change(screen.getByLabelText('Type to the session'), { target: { value: 'yes do it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    act(() => { live.handle({ type: 'hello', data: { server_time: Date.now() } }) })
    expect(await screen.findByText(/a permission prompt is on the screen; answer it first/)).toBeInTheDocument()
    expect(screen.getByText('yes do it')).toBeInTheDocument()
    // Send now is not offered while the prompt is on the screen.
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull()
    expect(store.inputs).toEqual([])
  })

  it('mid-turn, a message is queued as a bubble; edit, cancel and send now reach the daemon', async () => {
    store.busy = true
    render(<ChatView sessionId="s" canType />)
    const field = screen.getByLabelText('Type to the session')
    for (const text of ['first', 'second']) {
      fireEvent.change(field, { target: { value: text } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await screen.findByText(text)
    }
    expect(store.inputs).toEqual([])
    // No choice is asked: a plain outgoing bubble with a muted status line.
    expect(screen.getByText('Sends when Claude finishes · 1 of 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit the queued message: first' }))
    fireEvent.change(screen.getByLabelText('Edit the queued message'), { target: { value: 'first, better' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('first, better')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the queued message: second' }))
    await waitFor(() => expect(screen.queryByText('second')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    await waitFor(() => expect(store.inputs).toEqual(['first, better', '\r']))
    expect(store.calls).toEqual(['edit 100 first, better', 'cancel 101', 'now 100'])
    await waitFor(() => expect(screen.queryByText(/^Sends when Claude/)).toBeNull())
  })

  it('the queue follows the live socket: a frame from the other device redraws it', async () => {
    render(<ChatView sessionId="s" canType />)
    // The first read of the queue lands first; the frames come after it.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    act(() => {
      live.handle({ type: 'queue', data: { session_id: 's', waiting: 'turn', messages: [{ id: 7, session_id: 's', text: 'from the phone', created_at: 0, updated_at: 0 }] } })
    })
    expect(await screen.findByText('from the phone')).toBeInTheDocument()
    act(() => { live.handle({ type: 'queue', data: { session_id: 'other', waiting: '', messages: [] } }) })
    expect(screen.getByText('from the phone')).toBeInTheDocument()
    act(() => { live.handle({ type: 'queue', data: { session_id: 's', waiting: '', messages: [] } }) })
    await waitFor(() => expect(screen.queryByText('from the phone')).toBeNull())
  })

  it('/ at the start lists the commands; ↓ and Enter put one in the field, nothing is sent', async () => {
    render(<ChatView sessionId="s" canType />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: '/c', selectionStart: 2, selectionEnd: 2 } })
    expect(await screen.findByRole('option', { name: /\/clear/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /\/ship/ })).toBeNull()
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field.value).toBe('/compact ')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(store.inputs).toEqual([])
  })

  it('@ lists the folder\'s files, fuzzy; a tap inserts the path; Esc closes without changing the text', async () => {
    render(<ChatView sessionId="s" canType />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'look at @qu', selectionStart: 11, selectionEnd: 11 } })
    const opt = await screen.findByRole('option', { name: /queue\.go/ })
    fireEvent.click(opt)
    expect(field.value).toBe('look at @src/queue.go ')
    fireEvent.change(field, { target: { value: 'mail me@x and @', selectionStart: 15, selectionEnd: 15 } })
    expect(await screen.findByRole('listbox', { name: 'Files' })).toBeInTheDocument()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field.value).toBe('mail me@x and @')
  })

  it('the session ending while a message waits turns it into a draft, still on screen', () => {
    const { rerender } = render(<ChatView sessionId="s" canType />)
    setPhase('reconnecting')
    fireEvent.change(screen.getByLabelText('Type to the session'), { target: { value: 'one more' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    rerender(<ChatView sessionId="s" canType={false} ended />)
    expect(screen.getByText('Not sent — the session ended')).toBeInTheDocument()
    expect(store.inputs).toEqual([])
  })

  it('an ended session opened afresh has no input', () => {
    render(<ChatView sessionId="s" canType={false} ended />)
    expect(screen.queryByLabelText('Type to the session')).toBeNull()
  })

  it('a photo is saved by the daemon, shown as a chip, and pasted before the words as the desktop terminal pastes it', async () => {
    render(<ChatView sessionId="s" canType />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    fireEvent.change(screen.getByTestId('photo-picker'), { target: { files: [new File(['x'], 'IMG_0001.png', { type: 'image/png' })] } })
    expect(await screen.findByRole('button', { name: 'Remove Image 1' })).toBeInTheDocument()
    expect(field.value).toBe('')
    expect(store.inputs).toEqual([])
    fireEvent.change(field, { target: { value: 'what is wrong here?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    // The paste the desktop terminal writes for a dropped image, then the words and Enter.
    await waitFor(() => expect(store.inputs).toEqual(['\x1b[200~"/data/paste/IMG_0001.png"\x1b[201~', 'what is wrong here?', '\r']), { timeout: 1000 })
  })

  it('a viewer gets no input', async () => {
    render(<ChatView sessionId="s" canType={false} />)
    expect(screen.queryByLabelText('Type to the session')).toBeNull()
  })
})
