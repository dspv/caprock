/**
 * A session on another computer, drawn as a tab of one of this machine's
 * sessions is (issue #1085; owner, 2026-11-28, translated: "I started a
 * session from the Mac on the Windows PC — what is this ugly half-mobile
 * interface"). It is the machine page in tab mode (`/?machine=<id>&as=tab`,
 * lib/machinepage machineTabURL), in a frame of the app's workspace, whose
 * every `/v1/…` request and socket main.tsx has sent to that computer
 * through this daemon's `/v1/m/<id>/…` proxy. So the component tree is the
 * local tab's own, read from there:
 *
 * - the pane is TerminalStack with the one session in it — the live
 *   terminal first, with the composer, the quick replies, the limit and API
 *   error strips exactly as on a tab here (components/TerminalTabs.tsx);
 * - the chat is ChatView over the terminal, the terminal still mounted under
 *   it, as AppShell draws it;
 * - the inspector is Inspector, the agent Cockpit beside it;
 * - a session that computer cannot attach a terminal to (started in a
 *   terminal there, or ended) is ObservePane, as on a tab here.
 *
 * The window around it owns the tab strip: its Chat/Terminal switch and ⌘I
 * reach this page as a MachineTabState message, and what is asked from in
 * here — *Open the terminal*, the inspector's ×, Close, one of the app's
 * keys pressed while this page has the keyboard — goes back up as a
 * MachineTabAsk. The keys go up because a frame keeps its key presses:
 * without that ⌘1–⌘9, ⌘W, ⌘T and ⌘I did nothing from a remote terminal.
 *
 * What cannot apply here is left out, never drawn broken: opening a file of
 * that computer in a file tab, its editor, the Changes view and the
 * Pipeline are this window's and would read this machine (each is a tab of
 * its own here). The cockpit's Changes list still shows the files; *Open in
 * the dashboard* shows that computer's Session view over the tab, with a way
 * back.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRoute } from '@/lib/router'
import { applyTerminalChrome, getTerminalPrefs, subscribeTerminalPrefs } from '@/lib/termprefs'
import { useTheme } from '@/lib/theme'
import { TerminalStack } from './TerminalTabs'
import { ChatView } from './ChatView'
import { Inspector } from './Inspector'
import { PermissionPrompt } from './PermissionPrompt'
import { attachable, ObservePane } from './ObservePane'
import { ErrorBoundary } from './ErrorBoundary'
import { useWorkspaceData } from '@/lib/useWorkspaceData'
import { projectsApi } from '@/lib/projects'
import { heldAtPrompt } from '@/lib/needs'
import { api, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { sessionTitle } from '@/lib/sidebar'
import { isArrowCommand, matchAppShortcut } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import type { MachineTabAsk, MachineTabState } from '@/lib/machinepage'
import type { PaneLeaf, Tab } from '@/lib/tabs'

const SessionScreen = lazy(() => import('@/screens/Session').then((m) => ({ default: m.SessionScreen })))

/** Tells the window around the tab; nothing when there is none (opened on its own). */
export function askParent(ask: MachineTabAsk, w: Window = window): void {
  try {
    if (w.parent !== w) w.parent.postMessage(ask, w.location.origin)
  } catch { /* not ours to tell */ }
}

/** A field the user types text into, other than a terminal's own input (as AppShell has it). */
function isTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.classList.contains('xterm-helper-textarea')) return false
  return t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(t.type))
}

/**
 * The app's keys pressed in this frame go to the window around it, which
 * acts on them as on a key pressed over one of its own tabs. Anything else
 * — the terminal's keys, typing — stays here.
 */
export function forwardAppKeys(w: Window = window, isMac = isMacPlatform()): () => void {
  const onKey = (e: KeyboardEvent) => {
    const c = matchAppShortcut(e, isMac)
    if (!c) return
    if (e.repeat && c.kind !== 'tab' && !isArrowCommand(c)) return
    if (isArrowCommand(c) && isTextField(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    askParent({ type: 'caprock:machine-tab-ask', ask: 'key', key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, repeat: e.repeat }, w)
  }
  w.addEventListener('keydown', onKey, true)
  return () => w.removeEventListener('keydown', onKey, true)
}

export function MachineTab({ session: sid, initial }: {
  session: string
  /** How it opens, from its address, until the window says otherwise. */
  initial: { view: 'chat' | 'terminal'; inspector: boolean }
}) {
  const [state, setState] = useState<{ view: 'chat' | 'terminal'; inspector: boolean; visible: boolean }>({ ...initial, visible: true })
  // The app's own ground and tokens, the theme and the terminal's slab, as
  // AppShell sets them on its window (the frame shares its storage).
  useTheme()
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-app', '')
    applyTerminalChrome(getTerminalPrefs())
    const stop = subscribeTerminalPrefs((p) => applyTerminalChrome(p))
    return () => { stop(); root.removeAttribute('data-app') }
  }, [])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== window.parent) return
      const d = e.data as MachineTabState | undefined
      if (!d || d.type !== 'caprock:machine-tab') return
      setState((cur) => (cur.view === d.view && cur.inspector === d.inspector && cur.visible === d.visible ? cur : { view: d.view, inspector: d.inspector, visible: d.visible }))
    }
    window.addEventListener('message', onMessage)
    // Listening now: the window says how the tab stands, should it have
    // changed while this page was loading.
    askParent({ type: 'caprock:machine-tab-ask', ask: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])
  useEffect(() => forwardAppKeys(), [])

  // That computer's sessions, prompts and plan windows, read as the
  // workspace here reads this machine's.
  const data = useWorkspaceData()
  // A shell there — a setup step's, opened by *Show output* on the
  // computer's page (#1088) — is no session: no row, no cockpit, no chat;
  // it is its terminal alone, as a shell's tab here is.
  const shells = useApi(() => projectsApi.shells().catch(() => [] as { id: string }[]), [], { live: false })
  const isShell = !!shells.data?.some((x) => x.id === sid)
  const listed = useMemo(() => data.sessions.find((x) => x.session_id === sid), [data.sessions, sid])
  // Before the list answers, or for a session it no longer carries: its own page.
  const detail = useApi(() => (listed || !shells.data || isShell ? Promise.resolve(undefined) : api.session(sid).catch(() => undefined)), [sid, !!listed, !!shells.data, isShell], { live: false })
  const s: SessionSummary | undefined = listed ?? detail.data
  const sessionsById = useMemo(() => new Map(data.sessions.map((x) => [x.session_id, x] as const)), [data.sessions])
  // Only a session that computer can attach a terminal to gets one; any
  // other is its conversation, read-only, as a watched session's tab here.
  const kind: 'session' | 'observe' | 'shell' = isShell ? 'shell' : !s || attachable(s) ? 'session' : 'observe'
  const tab = useMemo<Tab>(() => ({
    id: `machine-tab:${sid}`,
    projectId: '',
    root: { type: 'pane', id: 'pane', target: { kind, sessionId: sid } },
    focusedPaneId: 'pane',
    title: s ? sessionTitle(s) : 'session',
  }), [sid, kind, s])
  const tabs = useMemo(() => [tab], [tab])

  // Held at a prompt before its first hook (#1118), the terminal is where the prompt is.
  const showChat = state.view === 'chat' && kind === 'session' && !heldAtPrompt(s)
  const canType = !!s && s.owned && s.status !== 'ended' && !s.detached
  const ended = !!s && (s.status === 'ended' || !!s.detached)
  const openTerminal = useCallback(() => {
    setState((cur) => ({ ...cur, view: 'terminal' }))
    askParent({ type: 'caprock:machine-tab-ask', ask: 'view', view: 'terminal' })
  }, [])
  const close = useCallback(() => askParent({ type: 'caprock:machine-tab-ask', ask: 'close' }), [])

  const renderObserve = useCallback((_t: Tab, leaf: PaneLeaf, visible: boolean): ReactNode => {
    if (!visible) return null
    return (
      <ObservePane
        sessionId={leaf.target.sessionId}
        session={s}
        title={tab.title}
        hasPermission={data.permissions.has(sid)}
        // Continued there under a new id: that one's own tab.
        onContinued={(newId, title, sameId) => { if (!sameId) askParent({ type: 'caprock:machine-tab-ask', ask: 'open', session: newId, title }); data.refresh() }}
        onOpenDashboard={() => { location.hash = `#/session/${encodeURIComponent(sid)}?tab=chat` }}
        onHide={close}
        onClose={close}
      />
    )
  }, [s, tab.title, data, sid, close])

  // *Open in the dashboard* and the cockpit's links lead to that computer's
  // Session view (the page's hash, empty while the tab is all there is):
  // drawn over the tab, which stays mounted under it, with a way back. Any
  // other screen would be that computer's, so it is not followed.
  const route = useRoute()
  const over = !!location.hash && location.hash !== '#' && location.hash !== '#/'
  const page = over && route.name === 'session' ? route : undefined
  useEffect(() => {
    if (over && route.name !== 'session') history.replaceState(null, '', location.pathname + location.search)
  }, [over, route.name])
  const back = useCallback(() => { history.replaceState(null, '', location.pathname + location.search); window.dispatchEvent(new HashChangeEvent('hashchange')) }, [])

  // Nothing is drawn until that computer says whether it is a shell: a
  // cockpit asked of a shell finds no session there.
  if (!shells.data) return null
  if (isShell) {
    return (
      <div data-machine-tab={sid} data-machine-shell={sid} className="flex h-screen w-full overflow-hidden bg-[var(--app-chrome-bg)]">
        <div className="relative min-w-0 flex-1">
          <TerminalStack tabs={tabs} visibleTabId={state.visible ? tab.id : undefined} sessions={sessionsById} permissions={data.permissions} />
        </div>
      </div>
    )
  }
  return (
    <div data-machine-tab={sid} className="flex h-screen w-full overflow-hidden bg-[var(--app-chrome-bg)]">
      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-0 flex flex-col">
          <div className="relative min-h-0 flex-1">
            <TerminalStack
              tabs={tabs}
              visibleTabId={state.visible ? tab.id : undefined}
              covered={showChat || !!page}
              sessions={sessionsById}
              permissions={data.permissions}
              renderObserve={renderObserve}
            />
            {showChat && state.visible && (
              <ChatView
                key={sid}
                sessionId={sid}
                canType={canType}
                ended={ended}
                agent={s?.agent}
                prompt
                desk
                foldKeys
                onOpenTerminal={openTerminal}
                className="app-slab absolute inset-0 z-10"
              />
            )}
            {page && (
              <div data-machine-tab-page className="app-scroll absolute inset-0 z-20 overflow-y-auto bg-bg">
                <div className="sticky top-0 z-10 flex h-[34px] items-center border-b border-[var(--app-hairline)] bg-bg px-3">
                  <button type="button" onClick={back} className="text-[12.5px] text-fg-muted hover:text-fg">← Back to the tab</button>
                </div>
                <div className="px-3 py-3">
                  <Suspense fallback={null}>
                    <SessionScreen key={`${page.id}:${page.tab ?? ''}`} id={page.id} tab={page.tab} at={page.at} />
                  </Suspense>
                </div>
              </div>
            )}
          </div>
          {kind === 'session' && !showChat && !state.inspector && (
            <div className="shrink-0 border-t border-[var(--app-hairline)] px-3 empty:hidden [&>*]:mb-2">
              <PermissionPrompt sessionId={sid} />
            </div>
          )}
        </div>
      </div>
      {state.inspector && (
        <div className="h-full shrink-0" style={{ width: 'var(--app-inspector-w)' }}>
          <ErrorBoundary label="inspector">
            <Inspector
              session={s}
              sessionId={sid}
              hasPermission={data.permissions.has(sid)}
              showPrompt={!showChat}
              onClose={() => { setState((cur) => ({ ...cur, inspector: false })); askParent({ type: 'caprock:machine-tab-ask', ask: 'inspector', open: false }) }}
              onDetach={close}
              summary={data.summary}
            />
          </ErrorBoundary>
        </div>
      )}
    </div>
  )
}
