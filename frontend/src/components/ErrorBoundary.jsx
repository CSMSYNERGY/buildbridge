import { Component } from 'react';
import { reportClientError } from '../lib/reportError.js';

// Catches render/lifecycle crashes anywhere below it. Without this a thrown
// render unmounts the whole tree and the customer sees a blank white page with
// nothing recorded anywhere; now they get a recovery card and the crash lands in
// error_events.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error, info) {
    reportClientError({
      kind: 'react_render_crash',
      severity: 'fatal',
      message: error?.message ?? 'React render crash',
      stack: error?.stack,
      context: { componentStack: String(info?.componentStack ?? '').slice(0, 2000) },
    });
  }

  render() {
    if (!this.state.crashed) return this.props.children;

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium" style={{ color: '#3d3672' }}>
          Something went wrong on this screen.
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          The problem has been reported to CSM Synergy automatically. Reloading usually
          fixes it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
          style={{ backgroundColor: '#3d3672' }}
        >
          Reload
        </button>
      </div>
    );
  }
}
