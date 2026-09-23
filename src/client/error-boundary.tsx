// Render guard for the panel.
//
// The board is a monitoring surface: it must never disappear because one card
// met data it did not expect. A rebuilt client bundle can be picked up by a
// page refresh while the host half is still the previous build, so a shape
// mismatch is a normal state, not a bug to crash on. React unmounts the whole
// tree on an uncaught render error, which is exactly the blank panel this
// guards against — the message stays visible and the rest of the board keeps
// rendering.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from './i18n'

interface PanelErrorBoundaryProps {
  readonly children: ReactNode
}

interface PanelErrorBoundaryState {
  readonly error: string | null
}

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): PanelErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the detail in the console for a bug report; the panel shows the gist.
    console.error('[dsh-perf-lens] panel render failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="pl-card">
          <div className="pl-card-title">{t('renderFailed')}</div>
          <div className="pl-error">{this.state.error}</div>
          <div className="pl-note">{t('renderFailedHint')}</div>
        </div>
      )
    }
    return this.props.children
  }
}
