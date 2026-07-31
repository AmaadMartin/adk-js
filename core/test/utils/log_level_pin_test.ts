/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '@google/adk';
import {Console} from 'node:console';
import {Writable} from 'node:stream';
import {describe, expect, it} from 'vitest';

/**
 * Returns everything `fn` writes through the global console.
 *
 * `SimpleLogger`'s winston Console transport writes to the stream held by
 * whatever `globalThis.console` is at log time, so swapping in a `Console`
 * bound to an in-memory stream captures it. Vitest replaces the global console
 * with its own instance backed by a private stream, which is why spying on
 * `process.stdout.write` or `console.log` captures nothing here.
 */
function captureConsoleOutput(fn: () => void): string {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: unknown, _encoding: string, callback: () => void) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const original = globalThis.console;
  globalThis.console = new Console({stdout: stream, stderr: stream});
  try {
    fn();
  } finally {
    globalThis.console = original;
  }
  return chunks.join('');
}

/**
 * Pins the `setupFiles` wiring in `vitest.config.ts`. The log level is
 * module-level state, so a `globalSetup` file running in the Vitest main
 * process cannot reach the forked worker this test runs in; only a setup file
 * can. There is no public read accessor for the effective level, so these
 * assert on what the logger writes.
 */
describe('test worker log level', () => {
  it('suppresses info logs', () => {
    expect(captureConsoleOutput(() => getLogger().info('info-pin-probe'))).toBe(
      '',
    );
  });

  it('still emits error logs', () => {
    expect(
      captureConsoleOutput(() => getLogger().error('error-pin-probe')),
    ).toContain('error-pin-probe');
  });
});
