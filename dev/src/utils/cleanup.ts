/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Runner} from '@google/adk';

import {AdkLogger} from './logger.js';

const logger = new AdkLogger({label: 'Cleanup', colorize: {all: true}});

/** How long teardown waits for the runners before it gives up on them. */
const RUNNER_CLOSE_TIMEOUT_MS = 30_000;

/**
 * Closes every runner concurrently, and gives up after 30 seconds.
 *
 * Teardown is best-effort: this never throws. A runner that fails to close is
 * logged, and it does not stop the other runners from closing. A runner that
 * is still closing at the deadline is abandoned, so a wedged tool server
 * cannot hold up shutdown.
 *
 * @param runners The runners to close.
 */
export async function closeRunners(runners: Runner[]): Promise<void> {
  if (runners.length === 0) {
    return;
  }

  let outstanding = runners.length;
  const closing = runners.map(async (runner) => {
    try {
      await runner.close();
    } catch (e: unknown) {
      logger.warn('Failed to close a runner:', e);
    }
    outstanding--;
  });

  // A live timer keeps the Node event loop alive, so clear it on the fast path.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RUNNER_CLOSE_TIMEOUT_MS);
  });
  await Promise.race([Promise.all(closing), deadline]);
  clearTimeout(timer);

  if (outstanding > 0) {
    logger.warn(`${outstanding} runner close tasks didn't complete in time`);
  }
}
