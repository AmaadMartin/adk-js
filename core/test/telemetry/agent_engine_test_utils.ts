/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Express} from 'express';
import {expect} from 'vitest';

import {RequestDrivenMetricReader} from '../../src/telemetry/agent_engine.js';

/**
 * Records the order of the hook and submit calls the middleware makes.
 *
 * The counterpart of adk-python's `_SpyReader` in
 * `tests/unittests/telemetry/test_agent_engine.py`.
 */
export class SpyReader implements RequestDrivenMetricReader {
  readonly events: string[] = [];

  noteRequestStart(): boolean {
    this.events.push('start');
    return true;
  }

  noteRequestEnd(): boolean {
    this.events.push('end');
    return true;
  }

  submitCollect(): Promise<void> | undefined {
    this.events.push('submit');
    return undefined;
  }
}

/** Counts how often `event` was recorded. */
export function countEvents(reader: SpyReader, event: string): number {
  return reader.events.filter((recorded) => recorded === event).length;
}

/**
 * Serves `app` on an ephemeral loopback port for the duration of `visit`.
 *
 * The middleware hooks a real `res`, so these tests drive a real Express
 * request over a real socket rather than a stand-in response object.
 */
export async function serve(
  app: Express,
  visit: (url: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    expect.fail('the test server did not bind a port');
  }

  try {
    await visit(`http://127.0.0.1:${address.port}`);
  } finally {
    // `fetch` keeps the socket alive, which would stall `close()`.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
