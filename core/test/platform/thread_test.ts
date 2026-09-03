/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createThread,
  getLogger,
  setLogger,
  setThreadFactory,
  type Logger,
  type Thread,
  type ThreadFactory,
  type ThreadTarget,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resetThreadFactory} from '../../src/platform/thread.js';

/** A logger that keeps every `error` call so a test can assert on it. */
class RecordingLogger implements Logger {
  readonly errors: unknown[][] = [];

  error(...args: unknown[]): void {
    this.errors.push(args);
  }

  log(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  setLogLevel(): void {}
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

/** Lets every pending microtask and timer callback run. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('createThread', () => {
  afterEach(() => {
    resetThreadFactory();
  });

  it('does not run the target when the thread is created', async () => {
    let ran = false;
    const thread = createThread(() => {
      ran = true;
    });

    expect(ran).toBe(false);
    expect(thread.isAlive()).toBe(false);

    await tick();
    expect(ran).toBe(false);
  });

  it('returns from start() before the target runs', async () => {
    let ran = false;
    const thread = createThread(() => {
      ran = true;
    });

    thread.start();
    expect(ran).toBe(false);

    await thread.join();
    expect(ran).toBe(true);
  });

  it('forwards positional arguments to the target', async () => {
    const seen: Array<[number, string]> = [];
    const target = (count: number, label: string): void => {
      seen.push([count, label]);
    };

    const thread = createThread(target, 1, 'a');
    thread.start();
    await thread.join();

    expect(seen).toEqual([[1, 'a']]);
  });

  it('waits for an async target to settle before join() resolves', async () => {
    const gate = deferred();
    const thread = createThread(() => gate.promise);

    thread.start();
    let joined = false;
    void thread.join().then(() => {
      joined = true;
    });

    await tick();
    expect(joined).toBe(false);

    gate.resolve();
    await thread.join();
    expect(joined).toBe(true);
  });

  it('reports isAlive() across the whole lifecycle', async () => {
    const gate = deferred();
    const thread = createThread(() => gate.promise);

    expect(thread.isAlive()).toBe(false);

    thread.start();
    await tick();
    expect(thread.isAlive()).toBe(true);

    gate.resolve();
    await thread.join();
    expect(thread.isAlive()).toBe(false);
  });

  it('throws on a second start() and runs the target once', async () => {
    let calls = 0;
    const thread = createThread(() => {
      calls++;
    });

    thread.start();
    expect(() => thread.start()).toThrow(
      `Thread ${thread.name} has already been started.`,
    );

    await thread.join();
    expect(calls).toBe(1);
  });

  it('throws when join() is called before start()', () => {
    const thread = createThread(() => {});

    expect(() => thread.join()).toThrow(
      `Thread ${thread.name} cannot be joined before it starts.`,
    );
  });

  it('resolves every join() call and runs the target once', async () => {
    let calls = 0;
    const thread = createThread(() => {
      calls++;
    });

    thread.start();
    await expect(thread.join()).resolves.toBeUndefined();
    await expect(thread.join()).resolves.toBeUndefined();

    expect(calls).toBe(1);
  });

  it('numbers unnamed threads and keeps an assigned name', () => {
    const thread = createThread(() => {});

    expect(thread.name).toMatch(/^Thread-\d+$/);

    thread.name = 'bqaa-orphan-client-close';
    expect(thread.name).toBe('bqaa-orphan-client-close');
  });
});

describe('createThread failure reporting', () => {
  let recorder: RecordingLogger;
  let previousLogger: Logger;

  beforeEach(() => {
    recorder = new RecordingLogger();
    previousLogger = getLogger();
    setLogger(recorder);
  });

  afterEach(() => {
    setLogger(previousLogger);
    resetThreadFactory();
  });

  it('logs a synchronous throw and leaves join() resolved', async () => {
    const failure = new Error('boom');
    const thread = createThread(() => {
      throw failure;
    });

    thread.start();
    await expect(thread.join()).resolves.toBeUndefined();

    expect(thread.isAlive()).toBe(false);
    expect(recorder.errors).toEqual([
      [`Thread ${thread.name} target failed:`, failure],
    ]);
  });

  it('logs a rejected async target and leaves join() resolved', async () => {
    const failure = new Error('async boom');
    const gate = deferred();
    const thread = createThread(() => gate.promise);
    thread.name = 'reader';

    thread.start();
    gate.reject(failure);
    await expect(thread.join()).resolves.toBeUndefined();

    expect(thread.isAlive()).toBe(false);
    expect(recorder.errors).toEqual([
      ['Thread reader target failed:', failure],
    ]);
  });
});

describe('setThreadFactory', () => {
  afterEach(() => {
    resetThreadFactory();
  });

  it('delegates createThread to the installed factory', async () => {
    const stub: Thread = {
      name: 'stub',
      start: () => {},
      join: () => Promise.resolve(),
      isAlive: () => false,
    };
    const seenCalls: Array<{target: unknown; args: unknown[]}> = [];
    const factory: ThreadFactory = {
      createThread<Args extends unknown[]>(
        target: ThreadTarget<Args>,
        ...args: Args
      ): Thread {
        seenCalls.push({target, args});
        return stub;
      },
    };
    setThreadFactory(factory);

    const received: number[] = [];
    const target = (value: number): void => {
      received.push(value);
    };
    const thread = createThread(target, 7);

    expect(thread).toBe(stub);
    expect(seenCalls).toEqual([{target, args: [7]}]);

    thread.start();
    await thread.join();
    expect(received).toEqual([]);
  });

  it('restores the built-in implementation on reset', async () => {
    let factoryCalls = 0;
    setThreadFactory({
      createThread<Args extends unknown[]>(
        _target: ThreadTarget<Args>,
        ..._args: Args
      ): Thread {
        factoryCalls++;
        throw new Error('the factory must not be called after a reset');
      },
    });
    resetThreadFactory();

    let ran = false;
    const thread = createThread(() => {
      ran = true;
    });
    thread.start();
    await thread.join();

    expect(ran).toBe(true);
    expect(factoryCalls).toBe(0);
  });
});

describe('concurrent threads', () => {
  afterEach(() => {
    resetThreadFactory();
  });

  it('runs one writer and two readers to completion', async () => {
    const store: string[] = [];
    const readBack: string[][] = [];

    const writer = createThread(async () => {
      await tick();
      store.push('entry');
    });
    const readers = [0, 1].map((index) =>
      createThread(async (slot: number) => {
        await tick();
        readBack[slot] = [...store];
      }, index),
    );

    const threads = [writer, ...readers];
    for (const thread of threads) {
      thread.start();
    }
    await Promise.all(threads.map((thread) => thread.join()));

    expect(store).toEqual(['entry']);
    expect(readBack).toHaveLength(2);
    expect(threads.every((thread) => !thread.isAlive())).toBe(true);
  });
});
