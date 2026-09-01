/**
 * Namespaced logger.
 *
 * Two non-obvious requirements shape this:
 *
 *  - NeuraTube ships zero telemetry. Logging is local-only, console-only, and
 *    off by default in production builds so we never pollute a page we do not
 *    own. Users opt in via the debug setting.
 *  - Everything passes through `redact()` first. A stack trace that leaks an
 *    API key into a screenshot the user pastes into an issue is a real, boring
 *    way to burn someone's credits.
 */

import { redact } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const PREFIX = 'NeuraTube';

/** Enabled by default in dev builds; toggled at runtime by the debug setting. */
let enabled: boolean = __DEV__;

/** Turn verbose logging on or off (wired to storage.settings.debugLogging). */
export function setLoggingEnabled(value: boolean): void {
  enabled = value;
}

export function isLoggingEnabled(): boolean {
  return enabled;
}

function emit(level: LogLevel, scope: string, args: readonly unknown[]): void {
  // Warnings and errors always surface: silencing a genuine failure makes the
  // extension look broken rather than noisy.
  if (!enabled && level !== 'warn' && level !== 'error') return;

  const label = `[${PREFIX}:${scope}]`;
  const safe = args.map((arg) => redact(arg));

  switch (level) {
    case 'warn':
      console.warn(label, ...safe);
      return;
    case 'error':
      console.error(label, ...safe);
      return;
    case 'debug':
    case 'info':
      // eslint-disable-next-line no-console -- local-only diagnostics, gated on the debug setting
      console.log(label, ...safe);
      return;
  }
}

export interface Logger {
  debug(...args: readonly unknown[]): void;
  info(...args: readonly unknown[]): void;
  warn(...args: readonly unknown[]): void;
  error(...args: readonly unknown[]): void;
  child(childScope: string): Logger;
}

/** Create a logger for a subsystem, e.g. `createLogger('panel')`. */
export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => {
      emit('debug', scope, args);
    },
    info: (...args) => {
      emit('info', scope, args);
    },
    warn: (...args) => {
      emit('warn', scope, args);
    },
    error: (...args) => {
      emit('error', scope, args);
    },
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}
