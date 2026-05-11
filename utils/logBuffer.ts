// In-app log capture for production builds where Metro isn't attached.
//
// We monkey-patch `console.log/warn/error` once at app start and tee every
// call into a fixed-size ring buffer. The original console methods still
// fire, so Metro and the iOS device console see the same output during
// development. The Debug → View Logs screen reads from `getLogs()` to
// surface what's happening on a TestFlight or Ad Hoc build.
//
// Ring buffer is bounded at MAX_LINES to keep memory predictable on a long-
// running session. Once full, oldest line is evicted on each push.

export type LogLevel = 'log' | 'warn' | 'error';

export interface LogLine {
  timestamp: number;
  level: LogLevel;
  message: string;
}

const MAX_LINES = 200;

let buffer: LogLine[] = [];
let installed = false;

export function addLog(level: LogLevel, message: string): void {
  buffer.push({ timestamp: Date.now(), level, message });
  if (buffer.length > MAX_LINES) {
    // Drop the oldest line. Splice in place rather than reassigning so
    // every caller of getLogs() sees a consistent reference if they hold
    // one (we still slice on read, so this is belt-and-suspenders).
    buffer.splice(0, buffer.length - MAX_LINES);
  }
}

export function getLogs(): LogLine[] {
  // Return a copy so consumers can't mutate the internal buffer.
  return buffer.slice();
}

export function clearLogs(): void {
  buffer = [];
}

/**
 * Monkey-patches console.log/warn/error to ALSO push into the in-memory
 * ring buffer. Idempotent — calling more than once is a no-op.
 *
 * Must be invoked once at app start (see app/_layout.tsx). The patch runs
 * synchronously and has zero ongoing overhead beyond the args→string format
 * cost; we accept that cost because the buffer is the only window we have
 * into production builds.
 */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    safePush('log', args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    safePush('warn', args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    safePush('error', args);
  };
}

function safePush(level: LogLevel, args: unknown[]): void {
  // Never let a buggy formatter take down the app. The buffer is best-
  // effort diagnostics — failure to capture a line should be invisible
  // to the original console.* caller.
  try {
    addLog(level, formatArgs(args));
  } catch {
    // ignore
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(formatOne).join(' ');
}

function formatOne(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) {
    return v.stack ?? `${v.name}: ${v.message}`;
  }
  try {
    const s = JSON.stringify(v);
    // Truncate to keep a single log entry from blowing past the buffer's
    // useful size. 2KB is plenty for diagnostics; raw axios error blobs
    // can be 50KB+ and would swamp the screen otherwise.
    return s.length > 2048 ? `${s.slice(0, 2048)}…` : s;
  } catch {
    return String(v);
  }
}
