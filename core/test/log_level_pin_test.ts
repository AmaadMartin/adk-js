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
 * The winston Console transport behind the ADK logger writes to whatever
 * `globalThis.console` is bound to at log time, so swapping in a `Console`
 * backed by an in-memory stream captures it. Spying on `console.log` or
 * `process.stdout.write` captures nothing here.
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

describe('test worker log level', () => {
  it('suppresses logs below ERROR', () => {
    expect(captureConsoleOutput(() => getLogger().warn('warn-pin-probe'))).toBe(
      '',
    );
  });

  it('still emits ERROR logs', () => {
    expect(
      captureConsoleOutput(() => getLogger().error('error-pin-probe')),
    ).toContain('error-pin-probe');
  });
});
