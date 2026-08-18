import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State { error: Error | null }

/** Last line of defence: a screen that throws shows an inline notice instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[caprock ui]', error, info.componentStack) }
  render() {
    if (this.state.error) {
      return (
        <div className="border border-danger/50 bg-danger/10 rounded-[var(--radius-panel)] px-3 py-2 text-[12px]">
          <div className="text-danger font-medium">{this.props.label ?? 'This view'} failed to render</div>
          <div className="mono text-fg-muted mt-1">{this.state.error.message}</div>
          <button className="mt-2 border border-border px-2 py-0.5 rounded-sm text-fg-muted hover:text-fg" onClick={() => this.setState({ error: null })}>retry</button>
        </div>
      )
    }
    return this.props.children
  }
}
