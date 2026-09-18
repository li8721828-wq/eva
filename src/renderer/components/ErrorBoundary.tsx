import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[Eva] React Error Boundary caught:', error, errorInfo.componentStack)
    try {
      const stack = `${error.message}\n\n${error.stack || ''}\n\nComponent stack:\n${errorInfo.componentStack || ''}`
      window.localStorage.setItem('eva.last-render-error', stack)
    } catch {
      // ignore
    }
  }

  handleReload = (): void => {
    window.location.reload()
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-white text-zinc-900 gap-6 p-8">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100 border border-red-200">
            <AlertTriangle className="h-8 w-8 text-red-500" />
          </div>

          <div className="text-center space-y-2 max-w-md">
            <h1 className="text-xl font-semibold text-zinc-900">Something went wrong</h1>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Eva encountered an unexpected error. You can try to recover or reload the application.
            </p>
          </div>

          {this.state.error && (
            <div className="w-full max-w-2xl rounded-lg border border-zinc-200 bg-zinc-50 p-4">
              <p className="text-xs font-mono text-zinc-500 mb-1">Error details:</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs font-mono text-red-600 break-words">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 transition-colors shadow-sm"
            >
              <RefreshCw className="h-4 w-4" />
              Try Again
            </button>
            <button
              onClick={this.handleReload}
              className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm text-white hover:bg-violet-700 transition-colors shadow-sm"
            >
              Reload App
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
