import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

export type WatchFn = (
  path: string,
  options: { recursive?: boolean },
  listener: (event: string, filename: string | null) => void
) => { close(): void };

export type SpawnFn = (
  cmd: string,
  args: string[],
  options: { cwd?: string; stdio?: unknown }
) => {
  stderr: { on(event: string, listener: (data: Buffer) => void): void } | null;
  on(event: string, listener: (arg: unknown) => void): void;
};

export interface HotReloadWatcherOptions {
  /** Directories or files to watch. */
  watchPaths: string[];
  /** Working directory for tsc --build (defaults to process.cwd()). */
  cwd?: string;
  /**
   * How long to wait after the last file change before compiling (default: 30 000 ms).
   * Set higher when developers routinely edit many files across several minutes.
   * The timer resets on every new change, so compile only fires after a period of silence.
   */
  debounceMs?: number;
  /** Called after a successful compile or after an .env file change. */
  onRestartNeeded: () => void;
  /** Called when tsc --build exits non-zero. Restart is NOT triggered. */
  onCompileError?: (stderr: string) => void;
  /** Inject a custom spawn function (for testing). */
  spawnFn?: SpawnFn;
  /** Inject a custom watch function (for testing). */
  watchFn?: WatchFn;
}

/**
 * Watches source files and .env files for changes. On a TypeScript change it
 * runs tsc --build and, on success, calls onRestartNeeded. On an .env change
 * it calls onRestartNeeded directly. Multiple rapid changes within debounceMs
 * are collapsed into a single compile/notify.
 */
export class HotReloadWatcher {
  private readonly cwd: string;
  private readonly debounceMs: number;
  private readonly onRestartNeeded: () => void;
  private readonly onCompileError?: (stderr: string) => void;
  private readonly spawnFn: SpawnFn;
  private readonly watchFn: WatchFn;
  private readonly watchPaths: string[];

  private watchers: Array<{ close(): void }> = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(options: HotReloadWatcherOptions) {
    this.watchPaths = options.watchPaths;
    this.cwd = options.cwd ?? process.cwd();
    this.debounceMs = options.debounceMs ?? 30_000;
    this.onRestartNeeded = options.onRestartNeeded;
    this.onCompileError = options.onCompileError;
    this.spawnFn = options.spawnFn ?? (spawn as unknown as SpawnFn);
    this.watchFn = options.watchFn ?? (watch as unknown as WatchFn);
  }

  start(): void {
    for (const watchPath of this.watchPaths) {
      const watcher = this.watchFn(
        watchPath,
        { recursive: true },
        (_event, filename) => {
          if (filename) this._handleFileChange(filename);
        },
      );
      this.watchers.push(watcher);
    }
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  private _handleFileChange(filename: string): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;

      const base = basename(filename);
      if (base.startsWith('.env')) {
        this.onRestartNeeded();
      } else if (filename.endsWith('.ts') || filename.endsWith('.tsx')) {
        void this._runCompile();
      }
    }, this.debounceMs);
  }

  private _runCompile(): Promise<void> {
    return new Promise<void>(resolve => {
      let stderrOutput = '';

      const child = this.spawnFn('npx', ['tsc', '--build'], {
        cwd: this.cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      child.on('close', (code: unknown) => {
        if (code === 0) {
          this.onRestartNeeded();
        } else {
          const msg = stderrOutput || `tsc --build exited with code ${String(code)}`;
          this.onCompileError?.(msg);
        }
        resolve();
      });

      child.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.onCompileError?.(msg);
        resolve();
      });
    });
  }
}
