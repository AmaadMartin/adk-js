/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`, branch `main`:
 * `tests/unittests/workflow/test_node_runner_failure.py`, which covers
 * `src/google/adk/workflow/_node_runner.py`.
 *
 * Only the four error-event tests are ported; the sixteen retry-policy tests
 * in that file are already covered by `node_execution_test.ts` and
 * `node_error_event_test.ts`. Reference test names are kept verbatim.
 */

import {describe, expect, it} from 'vitest';
import {isNodeErrorEvent} from '../../src/workflow/node_error_event.js';
import {
  driveNodeRunner,
  driveNodeRunnerFailure,
  FnNode,
} from './test_helpers.js';

/** A retryable failure, matched by name in a `retryConfig`. */
class CustomRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomRetryableError';
  }
}

/**
 * A genai-style client failure: the canonical status is a string, and the
 * transport code beside it is a number.
 */
class ClientError extends Error {
  readonly status = 'PERMISSION_DENIED';
  readonly code = 403;

  constructor() {
    super('403 PERMISSION_DENIED. Egress request is not authorized');
  }
}

/** Named for the reference exception, so the ported assertions read the same. */
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

describe('node runner — an error event per failed attempt', () => {
  it('test_error_event_emitted_on_failure', async () => {
    const boom = new Error('Something went wrong');
    const node = new FnNode('FlakyNode', () => {
      throw boom;
    });

    const {events, thrown} = await driveNodeRunnerFailure(node);

    const errorEvents = events.filter(isNodeErrorEvent);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].author).toBe('FlakyNode');
    expect(errorEvents[0].errorMessage).toBe('Something went wrong');
    expect(errorEvents[0].attemptCount).toBe(1);
    expect(thrown).toBe(boom);
  });

  it('test_error_event_emitted_on_each_retry', async () => {
    let attempts = 0;
    const node = new FnNode(
      'FlakyNode',
      () => {
        attempts += 1;
        if (attempts < 3) {
          throw new CustomRetryableError('Transient error');
        }
        return 'Success';
      },
      {
        retryConfig: {
          maxAttempts: 3,
          initialDelay: 0,
          jitter: 0,
          exceptions: ['CustomRetryableError'],
        },
      },
    );

    const {child, events} = await driveNodeRunner(node);

    const errorEvents = events.filter(isNodeErrorEvent);
    expect(errorEvents).toHaveLength(2);
    expect(errorEvents.map((e) => e.attemptCount)).toEqual([1, 2]);
    for (const errorEvent of errorEvents) {
      expect(errorEvent.errorType).toBe('CustomRetryableError');
      expect(errorEvent.errorMessage).toBe('Transient error');
    }
    // The node still produces its output after the retries.
    expect(child.output).toBe('Success');
  });

  it('test_node_runner_prefers_api_status_for_error_code', async () => {
    const node = new FnNode('ErrNode', () => {
      throw new ClientError();
    });

    const {events} = await driveNodeRunnerFailure(node);

    const errorEvents = events.filter(isNodeErrorEvent);
    expect(errorEvents).toHaveLength(1);
    // The string `.status` wins over the numeric `.code` beside it.
    expect(errorEvents[0].errorCode).toBe('PERMISSION_DENIED');
    expect(errorEvents[0].errorMessage).toContain(
      'Egress request is not authorized',
    );
  });

  it('test_node_runner_falls_back_to_class_name_without_status', async () => {
    const node = new FnNode('ErrNode', () => {
      throw new ValueError('boom');
    });

    const {events} = await driveNodeRunnerFailure(node);

    const errorEvents = events.filter(isNodeErrorEvent);
    expect(errorEvents).toHaveLength(1);
    // Divergence from adk-python, which falls back to the exception class name
    // for `error_code`. adk-js carries the class name separately as
    // `errorType` and keeps a generic code, which
    // `node_error_event_test.ts` already pins.
    expect(errorEvents[0].errorType).toBe('ValueError');
    expect(errorEvents[0].errorCode).toBe('UNKNOWN_ERROR');
  });

  it('test_node_runner_numeric_status_falls_through_to_code', async () => {
    // Not in the reference: adk-python's `isinstance(status, str)` guard is
    // there for a client whose `.status` is an HTTP number. This pins that the
    // port kept the guard rather than stringifying whatever `.status` holds.
    const node = new FnNode('ErrNode', () => {
      throw Object.assign(new Error('gateway timeout'), {
        status: 504,
        code: 'ETIMEDOUT',
      });
    });

    const {events} = await driveNodeRunnerFailure(node);

    const errorEvents = events.filter(isNodeErrorEvent);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].errorCode).toBe('ETIMEDOUT');
  });
});
