/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {withJsonlStdout, writeJsonlRecord} from '../../src/cli/jsonl_stdout.js';

/** Captures what each stream received, without letting it reach the terminal. */
function captureStreams(): {stdout: string[]; stderr: string[]} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return {stdout, stderr};
}

describe('withJsonlStdout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a record on stdout', async () => {
    const {stdout, stderr} = captureStreams();

    await withJsonlStdout(async () => {
      writeJsonlRecord('{"author":"model"}');
    });

    expect(stdout.join('')).toBe('{"author":"model"}\n');
    expect(stderr).toEqual([]);
  });

  it('moves a write it did not make to stderr', async () => {
    const {stdout, stderr} = captureStreams();

    await withJsonlStdout(async () => {
      // What a copy of the ADK logger this process cannot configure does.
      process.stdout.write('WARN: [ADK] Class Workflow is experimental.\n');
      writeJsonlRecord('{"author":"model"}');
    });

    expect(stdout.join('')).toBe('{"author":"model"}\n');
    expect(stderr.join('')).toContain('Class Workflow is experimental');
  });

  it('honours the callback form of write', async () => {
    const {stderr} = captureStreams();
    const callback = vi.fn();

    await withJsonlStdout(async () => {
      process.stdout.write('noise\n', callback);
    });

    expect(stderr.join('')).toContain('noise');
  });

  it('honours the encoding form of write', async () => {
    const {stderr} = captureStreams();

    await withJsonlStdout(async () => {
      process.stdout.write('noise\n', 'utf8');
    });

    expect(stderr.join('')).toContain('noise');
  });

  it('restores stdout when the body returns', async () => {
    const before = process.stdout.write;

    const result = await withJsonlStdout(async () => 'done');

    expect(result).toBe('done');
    expect(process.stdout.write).toBe(before);
  });

  it('restores stdout when the body throws', async () => {
    const before = process.stdout.write;

    await expect(
      withJsonlStdout(async () => {
        throw new Error('run failed');
      }),
    ).rejects.toThrow('run failed');

    expect(process.stdout.write).toBe(before);
  });

  it('writes to stdout again once the run is over', async () => {
    await withJsonlStdout(async () => {});
    const {stdout} = captureStreams();

    writeJsonlRecord('{"after":true}');

    expect(stdout.join('')).toBe('{"after":true}\n');
  });
});
