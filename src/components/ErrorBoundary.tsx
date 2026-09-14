import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Stops one broken screen from taking the window with it.
 *
 * React unmounts the whole tree when a render or an effect throws, which on a
 * desktop app looks like the application vanishing — no message, no console in
 * front of the operator, nothing to report but "it went blank". That is a
 * terrible thing to hand someone standing at an ingest station, and it says
 * nothing about which part failed.
 *
 * The pipeline is unaffected either way: it runs in the Rust host and does not
 * care what the window is doing.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
  /** Names the part that failed, so the message can say where. */
  label: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} failed`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-[220px] items-center justify-center p-8">
        <div className="max-w-[460px] text-center">
          <div className="font-condensed text-[13px] font-bold uppercase tracking-[.12em] text-accent">
            {this.props.label} stopped
          </div>
          <div className="mt-2.5 text-[13.5px] text-pretty text-body">
            Something in this part of the window went wrong. Everything else still works, and
            converting and uploading carry on regardless.
          </div>
          <div className="mt-3.5 machine text-[12px] text-pretty break-all text-quiet">
            {error.message}
          </div>
          <div className="mt-4 flex justify-center gap-2.5">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="csn-btn-capsule"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="csn-btn-capsule"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
