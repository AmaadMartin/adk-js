/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Background execution units, with a seam for host platforms.
 *
 * The default {@link Thread} gives concurrency, not parallelism: the target
 * runs on the same event loop as its caller, so a synchronous long-running
 * target still blocks that loop. It is not an OS thread and it isolates
 * nothing. A host that needs real parallelism installs its own implementation
 * through {@link setThreadFactory}, for example one backed by
 * `node:worker_threads`.
 *
 * Two pieces of `threading.Thread` are deliberately absent. There is no
 * `daemon` flag, because a pending promise does not hold the Node event loop
 * open, so the flag would have no reader. There are no keyword arguments,
 * because JavaScript has none; a caller passes an options object as an
 * ordinary positional argument instead.
 */

import {logger} from '../utils/logger.js';

/** Work to run on a thread. */
export type ThreadTarget<Args extends unknown[] = []> = (
  ...args: Args
) => void | Promise<void>;

/** A unit of background work. It is created unstarted. */
export interface Thread {
  /** Debug label. Defaults to `Thread-N`. */
  name: string;

  /** Schedules the target. Returns at once. Throws if already started. */
  start(): void;

  /** Resolves once the target has settled. Throws if not started. */
  join(): Promise<void>;

  /** True between `start()` and the target settling. */
  isAlive(): boolean;
}

/** Platform-specific replacement for the default thread implementation. */
export interface ThreadFactory {
  createThread<Args extends unknown[]>(
    target: ThreadTarget<Args>,
    ...args: Args
  ): Thread;
}

let threadCount = 0;

let threadFactory: ThreadFactory | undefined;

class DefaultThread<Args extends unknown[]> implements Thread {
  name = `Thread-${++threadCount}`;

  private settled?: Promise<void>;
  private running = false;

  constructor(
    private readonly target: ThreadTarget<Args>,
    private readonly args: Args,
  ) {}

  start(): void {
    if (this.settled !== undefined) {
      throw new Error(`Thread ${this.name} has already been started.`);
    }
    this.running = true;
    this.settled = this.run();
  }

  join(): Promise<void> {
    if (this.settled === undefined) {
      throw new Error(`Thread ${this.name} cannot be joined before it starts.`);
    }
    return this.settled;
  }

  isAlive(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    // Keeps the target off the caller's stack, so `start()` returns first.
    await Promise.resolve();
    try {
      await this.target(...this.args);
    } catch (error: unknown) {
      // Mirrors `threading.excepthook`: the failure is reported here and
      // `join()` stays silent, because callers rely on it never rejecting.
      logger.error(`Thread ${this.name} target failed:`, error);
    } finally {
      this.running = false;
    }
  }
}

/**
 * Creates an unstarted thread that runs `target` with `args` on `start()`.
 */
export function createThread<Args extends unknown[]>(
  target: ThreadTarget<Args>,
  ...args: Args
): Thread {
  if (threadFactory !== undefined) {
    return threadFactory.createThread(target, ...args);
  }
  return new DefaultThread(target, args);
}

/**
 * Installs `factory` for every later {@link createThread} call. Threads that
 * already exist keep their own implementation.
 */
export function setThreadFactory(factory: ThreadFactory): void {
  threadFactory = factory;
}

/** Restores the built-in thread implementation. */
export function resetThreadFactory(): void {
  threadFactory = undefined;
}
