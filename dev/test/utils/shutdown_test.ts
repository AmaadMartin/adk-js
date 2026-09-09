/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import {installShutdownHandlers} from '../../src/utils/shutdown.js';

/** Exit code a shell reports for a process killed by SIGINT: 128 + 2. */
const SIGINT_EXIT_CODE = 130;

/** Exit code a shell reports for a process killed by SIGTERM: 128 + 15. */
const SIGTERM_EXIT_CODE = 143;

/** Exit code for a shutdown that failed or was forced. */
const ABNORMAL_EXIT_CODE = 1;

function createLogger() {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLogLevel: vi.fn(),
  } satisfies Logger;
}

/** A promise plus the handles to settle it from the test body. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return {promise, resolve};
}

describe('installShutdownHandlers', () => {
  let logger: ReturnType<typeof createLogger>;
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    logger = createLogger();
    // Vitest's own signal listeners would otherwise be counted by the
    // listener assertions below, and removed by the handler under test.
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(vi.fn<typeof process.exit>());
  });

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    vi.restoreAllMocks();
  });

  it('stops the server before it exits 130 on SIGINT', async () => {
    const stopped = deferred();
    const stop = vi.fn(() => stopped.promise);
    installShutdownHandlers({stop}, logger);

    process.emit('SIGINT', 'SIGINT');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Received SIGINT, stopping the ADK dev server...',
    );
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    stopped.resolve();
    await vi.waitFor(() =>
      expect(exit).toHaveBeenCalledExactlyOnceWith(SIGINT_EXIT_CODE),
    );
  });

  it('stops the server before it exits 143 on SIGTERM', async () => {
    const stopped = deferred();
    const stop = vi.fn(() => stopped.promise);
    installShutdownHandlers({stop}, logger);

    process.emit('SIGTERM', 'SIGTERM');

    expect(stop).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    stopped.resolve();
    await vi.waitFor(() =>
      expect(exit).toHaveBeenCalledExactlyOnceWith(SIGTERM_EXIT_CODE),
    );
  });

  it('exits at once on a second signal instead of stopping twice', async () => {
    const stopped = deferred();
    const stop = vi.fn(() => stopped.promise);
    installShutdownHandlers({stop}, logger);

    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGINT', 'SIGINT');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Received SIGINT during shutdown, exiting now.',
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(ABNORMAL_EXIT_CODE);

    stopped.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(SIGINT_EXIT_CODE));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('logs a rejected stop() and exits 1', async () => {
    const failure = new Error('close failed');
    const stop = vi.fn(() => Promise.reject(failure));
    installShutdownHandlers({stop}, logger);

    process.emit('SIGINT', 'SIGINT');

    await vi.waitFor(() =>
      expect(exit).toHaveBeenCalledExactlyOnceWith(ABNORMAL_EXIT_CODE),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to stop the ADK dev server:',
      failure,
    );
  });

  it('displaces a listener that exits without awaiting teardown', async () => {
    const loaderListener = vi.fn<() => void>();
    process.on('SIGINT', loaderListener);
    const stop = vi.fn(() => Promise.resolve());
    installShutdownHandlers({stop}, logger);

    expect(process.listenerCount('SIGINT')).toBe(1);

    process.emit('SIGINT', 'SIGINT');

    expect(loaderListener).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it('installs exactly one listener per signal', () => {
    const stop = vi.fn(() => Promise.resolve());
    installShutdownHandlers({stop}, logger);

    expect(process.listenerCount('SIGINT')).toBe(1);
    expect(process.listenerCount('SIGTERM')).toBe(1);
  });
});
