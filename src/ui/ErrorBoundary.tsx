import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown instead of the crashed subtree (null = render nothing, e.g. on the audience output). */
  fallback?: ReactNode | ((error: Error, retry: () => void) => ReactNode);
  /** Re-mount automatically after this many ms (0 = wait for a manual retry). */
  retryAfter?: number;
  /** Where this boundary sits, for the error log. */
  name?: string;
}

interface State {
  error: Error | null;
  gen: number;
}

/** Keeps one broken panel from taking the whole operator window down with it. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, gen: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[${this.props.name ?? "ui"}] render error`, error, info.componentStack);
    recordError(`${this.props.name ?? "ui"}: ${error.message}`);
    if (this.props.retryAfter) {
      this.timer = setTimeout(() => this.retry(), this.props.retryAfter);
    }
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  retry = () => {
    this.timer = null;
    this.setState((s) => ({ error: null, gen: s.gen + 1 }));
  };

  render() {
    if (this.state.error) {
      const f = this.props.fallback;
      if (f === undefined)
        return (
          <div className="grid h-full w-full place-items-center p-4 text-center text-[12px] text-muted-foreground">
            <div>
              <div className="font-semibold text-destructive">This panel hit an error</div>
              <div className="mt-1 max-w-[320px] break-words text-[11px]">{this.state.error.message}</div>
              <button className="mt-2 rounded border border-border px-2 py-1 text-[11px] hover:bg-accent" onClick={this.retry}>
                Reload panel
              </button>
            </div>
          </div>
        );
      return typeof f === "function" ? f(this.state.error, this.retry) : f;
    }
    // A new key after an error forces a clean re-mount of the children.
    return <div key={this.state.gen} className="contents">{this.props.children}</div>;
  }
}

// ---------------------------------------------------------------- error log

export interface LoggedError {
  at: number;
  text: string;
}

const errors: LoggedError[] = [];
const listeners = new Set<() => void>();

export function recordError(text: string) {
  errors.push({ at: Date.now(), text });
  if (errors.length > 50) errors.shift();
  listeners.forEach((l) => l());
}

export function getErrors() {
  return errors;
}

export function onErrors(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

let installed = false;
/** Catch anything that escapes React: logged, never fatal. */
export function installGlobalErrorLog() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => recordError(e.message || String(e.error)));
  window.addEventListener("unhandledrejection", (e) => recordError(`Unhandled: ${String((e.reason as Error)?.message ?? e.reason)}`));
}
