/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService, LlmAgent, Runner} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {closeRunners} from '../../src/utils/cleanup.js';
import {AdkLogger} from '../../src/utils/logger.js';

/** Matches RUNNER_CLOSE_TIMEOUT_MS in src/utils/cleanup.ts. */
const RUNNER_CLOSE_TIMEOUT_MS = 30_000;

function createRunner(name: string): Runner {
  return new Runner({
    appName: 'test_app',
    agent: new LlmAgent({name}),
    sessionService: new InMemorySessionService(),
  });
}

describe('closeRunners', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should close every runner', async () => {
    const runners = [
      createRunner('agent1'),
      createRunner('agent2'),
      createRunner('agent3'),
    ];
    const closes = runners.map((runner) => vi.spyOn(runner, 'close'));

    await closeRunners(runners);

    for (const close of closes) {
      expect(close).toHaveBeenCalledTimes(1);
    }
  });

  it('should wait for the slowest runner', async () => {
    const fast = createRunner('fast_agent');
    const slow = createRunner('slow_agent');
    let slowClosed = false;
    const fastClose = vi.spyOn(fast, 'close');
    vi.spyOn(slow, 'close').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      slowClosed = true;
    });

    await closeRunners([fast, slow]);

    // Returning after the first runner finished would leave `slow` open.
    expect(fastClose).toHaveBeenCalledTimes(1);
    expect(slowClosed).toBe(true);
  });

  it('should not let one failure abort the rest', async () => {
    const first = createRunner('first_agent');
    const broken = createRunner('broken_agent');
    const last = createRunner('last_agent');
    const firstClose = vi.spyOn(first, 'close');
    vi.spyOn(broken, 'close').mockRejectedValue(new Error('close failed'));
    const lastClose = vi.spyOn(last, 'close');
    const warn = vi
      .spyOn(AdkLogger.prototype, 'warn')
      .mockImplementation(vi.fn());

    await expect(closeRunners([first, broken, last])).resolves.toBeUndefined();

    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(lastClose).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Failed to close a runner:',
      new Error('close failed'),
    );
  });

  it('should be a no-op with no runners', async () => {
    const armTimer = vi.spyOn(globalThis, 'setTimeout');

    await expect(closeRunners([])).resolves.toBeUndefined();

    expect(armTimer).not.toHaveBeenCalled();
  });

  it('should leave no pending timer once the runners have closed', async () => {
    vi.useFakeTimers();
    const runner = createRunner('prompt_agent');
    vi.spyOn(runner, 'close').mockResolvedValue(undefined);

    await closeRunners([runner]);

    // A live 30s timer would keep the Node event loop alive after shutdown.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should warn and return when a runner overruns the timeout', async () => {
    vi.useFakeTimers();
    const wedged = createRunner('wedged_agent');
    const prompt = createRunner('prompt_agent');
    vi.spyOn(wedged, 'close').mockReturnValue(new Promise<void>(() => {}));
    const promptClose = vi.spyOn(prompt, 'close').mockResolvedValue(undefined);
    const warn = vi
      .spyOn(AdkLogger.prototype, 'warn')
      .mockImplementation(vi.fn());

    const closing = closeRunners([wedged, prompt]);
    await vi.advanceTimersByTimeAsync(RUNNER_CLOSE_TIMEOUT_MS);

    await expect(closing).resolves.toBeUndefined();
    expect(promptClose).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "1 runner close tasks didn't complete in time",
    );
  });
});
