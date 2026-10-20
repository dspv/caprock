import { Component, type ErrorInfo, type ReactNode } from 'react'
import { crashIssueURL, crashMailURL, crashText, describeCrash, resetViewState, type Crash } from '@/lib/crashreport'
import { openExternal } from '@/lib/nudges'
import { extProps } from '@/lib/externalLinks'
import { shell } from '@/lib/shell'

interface Props {
  children: ReactNode
  label?: string
  /**
   * The whole page: a calm screen with a way back and a way to tell us,
   * instead of the blank (in the app, black) window a throw at the root
   * leaves behind.
   */
  full?: boolean
}

interface State { error: Error | null; crash: Crash | null; copied: boolean }

/** Last line of defence: a screen that throws shows a notice instead of a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, crash: null, copied: false }
  static getDerivedStateFromError(error: Error): Partial<State> { return { error, crash: describeCrash(error) } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[caprock ui]', error, info.componentStack)
    const crash = describeCrash(error, info.componentStack)
    this.setState({ crash })
    // The whole window fell to the crash screen: say why in the app's own
    // log on this machine, so the next report can be answered from it.
    if (this.props.full) shell.appLog(`crash screen: ${crash.message} on ${crash.lines[1] ?? ''}`).catch(() => {})
  }

  private copy = () => {
    const c = this.state.crash
    if (!c) return
    navigator.clipboard?.writeText(crashText(c)).then(() => this.setState({ copied: true }), () => {})
  }

  private report(c: Crash, small: boolean) {
    const link = small
      ? 'text-fg-muted underline-offset-2 hover:text-fg hover:underline'
      : 'rounded-sm border border-border px-2.5 py-1 text-fg-muted hover:text-fg'
    return (
      <>
        <button type="button" data-crash-issue className={link} {...extProps()} onClick={() => openExternal(crashIssueURL(c))}>Report on GitHub</button>
        <button type="button" data-crash-mail className={link} {...extProps()} onClick={() => openExternal(crashMailURL(c))}>Email us</button>
        <button type="button" data-crash-copy className={link} onClick={this.copy}>{this.state.copied ? 'Copied' : 'Copy details'}</button>
      </>
    )
  }

  render() {
    const { error, crash } = this.state
    if (!error || !crash) return this.props.children
    if (this.props.full) {
      return (
        <div data-crash-screen className="flex min-h-screen items-center justify-center bg-bg p-6 text-fg">
          <div className="w-full max-w-[460px] rounded-[var(--radius-panel)] border border-border bg-panel p-5 text-[13px]">
            <h1 className="text-[15px] font-medium">Caprock hit a snag</h1>
            <p className="mt-2 text-fg-muted">
              This window could not draw. Your sessions keep running in the background and nothing was lost.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" data-crash-reload className="rounded-sm bg-accent px-2.5 py-1 font-medium text-bg hover:opacity-90" onClick={() => location.reload()}>Reload</button>
              <button type="button" data-crash-reset className="rounded-sm border border-border px-2.5 py-1 text-fg-muted hover:text-fg"
                title="Forgets cached figures and the CI panel’s saved view, then reloads. Tabs and settings stay."
                onClick={() => { try { resetViewState() } catch { /* storage unavailable: a reload is all that is left */ } location.reload() }}>
                Reset the view and reload
              </button>
            </div>
            <p className="mt-5 text-fg-muted">If it keeps happening, tell us. You see the report before it goes, and it holds only the error, the version and your OS.</p>
            <div className="mt-2 flex flex-wrap gap-2 text-[12px]">{this.report(crash, false)}</div>
            <details className="mt-4 text-[12px] text-fg-faint">
              <summary className="cursor-pointer">Details</summary>
              <pre className="mono mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{crashText(crash)}</pre>
            </details>
          </div>
        </div>
      )
    }
    return (
      <div className="border border-danger/50 bg-danger/10 rounded-[var(--radius-panel)] px-3 py-2 text-[12px]">
        <div className="text-danger font-medium">{this.props.label ?? 'This view'} failed to render</div>
        <div className="mono text-fg-muted mt-1">{error.message}</div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button className="border border-border px-2 py-0.5 rounded-sm text-fg-muted hover:text-fg" onClick={() => this.setState({ error: null, crash: null, copied: false })}>retry</button>
          {this.report(crash, true)}
        </div>
      </div>
    )
  }
}
