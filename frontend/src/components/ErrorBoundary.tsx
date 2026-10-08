/**
 * The last line of defence between a render error and a white screen.
 *
 * Without this, one unexpected value from the API - a field that is null where
 * an array was assumed - unmounts the whole tree and the user is left looking
 * at nothing at all, with no way to tell a broken app from a slow one. A
 * planner that fails should still look like a planner, say what happened, and
 * offer the way back.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  message: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console rather than shown: the message above is for the
    // user, the stack is for whoever they report it to.
    console.error('Unhandled render error', error, info.componentStack)
  }

  render() {
    if (this.state.message === null) return this.props.children

    return (
      <div className="app-crash-shell font-sans" role="alert">
        <div className="app-crash-card">
          <h1 className="app-crash-title">Something went wrong displaying this plan</h1>
          <p className="app-crash-body">
            The trip itself was not lost — reloading starts a fresh session, and your recent
            trips are still in the History menu.
          </p>
          <p className="app-crash-detail font-mono">{this.state.message}</p>
          <button
            type="button"
            className="button-telematics-primary"
            onClick={() => window.location.reload()}
          >
            Reload the planner
          </button>
        </div>
      </div>
    )
  }
}
