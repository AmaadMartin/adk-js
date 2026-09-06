/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import {constants} from 'node:os';

/** The signals the dev server commands shut down on. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** Exit code offset a process killed by signal `n` conventionally reports. */
const SIGNAL_EXIT_BASE = 128;

/** Exit code for a shutdown that failed or was forced. */
const ABNORMAL_EXIT_CODE = 1;

/** The part of the dev API server that the shutdown handler drives. */
export interface StoppableServer {
  stop(): Promise<void>;
}

/**
 * Stops `server` on SIGINT and SIGTERM, then exits the process.
 *
 * Call this once, after `start()` resolves. `stop()` runs at most once per
 * process: a second signal exits immediately instead of starting a second
 * teardown.
 */
export function installShutdownHandlers(
  server: StoppableServer,
  logger: Logger,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: ShutdownSignal) => {
    if (shuttingDown) {
      // `http.Server.close()` waits for established connections to drain, so a
      // parked dev UI tab can hold `stop()` open. A second signal is the
      // operator's way out, and must not re-enter teardown.
      logger.warn(`Received ${signal} during shutdown, exiting now.`);
      process.exit(ABNORMAL_EXIT_CODE);
    } else {
      shuttingDown = true;
      logger.info(`Received ${signal}, stopping the ADK dev server...`);

      let exitCode = SIGNAL_EXIT_BASE + constants.signals[signal];
      try {
        await server.stop();
      } catch (e: unknown) {
        logger.error('Failed to stop the ADK dev server:', e);
        exitCode = ABNORMAL_EXIT_CODE;
      }

      process.exit(exitCode);
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    // The AgentLoader constructor installs a SIGINT listener that calls
    // `process.exit()`. Node runs every listener for a signal synchronously,
    // so leaving it in place would kill the process at the first `await` above
    // and teardown would never run. The server command owns the process, so it
    // takes the signal over.
    process.removeAllListeners(signal);

    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}
