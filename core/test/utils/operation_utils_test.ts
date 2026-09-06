/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {waitForOperation} from '../../src/utils/operation_utils.js';

/** Shape of the operations these tests poll. */
interface TestOperation {
  name?: string;
  done?: boolean;
  response?: {name?: string};
}

const PENDING: TestOperation = {name: 'operations/op', done: false};

describe('waitForOperation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an already done operation without polling', async () => {
    const done: TestOperation = {name: 'operations/op', done: true};
    const poll = vi.fn<() => Promise<TestOperation>>();

    await expect(
      waitForOperation({
        operation: done,
        poll,
        timeoutSeconds: 180,
        description: 'Foo creation',
      }),
    ).resolves.toBe(done);
    expect(poll).not.toHaveBeenCalled();
  });

  it('polls until the operation reports done', async () => {
    const finished: TestOperation = {done: true, response: {name: 'resource'}};
    const poll = vi
      .fn<() => Promise<TestOperation>>()
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValue(finished);

    const waiting = waitForOperation({
      operation: {name: 'operations/op', done: false},
      poll,
      timeoutSeconds: 180,
      description: 'Foo creation',
    });

    await vi.runAllTimersAsync();

    await expect(waiting).resolves.toBe(finished);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('throws once the deadline passes', async () => {
    const poll = vi
      .fn<() => Promise<TestOperation>>()
      .mockResolvedValue(PENDING);

    const waiting = waitForOperation({
      operation: {name: 'operations/op', done: false},
      poll,
      timeoutSeconds: 3,
      description: 'Foo creation',
    });

    await Promise.all([
      expect(waiting).rejects.toThrow(
        'Foo creation operation operations/op did not complete in time.',
      ),
      vi.runAllTimersAsync(),
    ]);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('polls once per second of the deadline', async () => {
    const poll = vi
      .fn<() => Promise<TestOperation>>()
      .mockResolvedValue(PENDING);

    const waiting = waitForOperation({
      operation: {name: 'operations/op', done: false},
      poll,
      timeoutSeconds: 7,
      description: 'Foo creation',
    });

    await Promise.all([
      expect(waiting).rejects.toThrow('did not complete in time.'),
      vi.runAllTimersAsync(),
    ]);
    expect(poll).toHaveBeenCalledTimes(7);
  });

  it('waits one poll interval before each poll', async () => {
    const poll = vi
      .fn<() => Promise<TestOperation>>()
      .mockResolvedValue(PENDING);

    const waiting = waitForOperation({
      operation: {name: 'operations/op', done: false},
      poll,
      timeoutSeconds: 2,
      description: 'Foo creation',
    });
    const rejection = expect(waiting).rejects.toThrow(
      'did not complete in time.',
    );

    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);

    await rejection;
  });
});
