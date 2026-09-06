/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/workflow/test_node_runner_failure.py`, for the error events
 * a failing node produces: one per failed attempt, coded by the error.
 *
 * The retry-policy tests in that file are covered here by
 * `node_execution_test.ts` and `node_error_event_test.ts`; this file ports the
 * error-event cases those two do not reach.
 *
 * A `test_`-prefixed name is a verbatim port and names a test in the reference
 * file. The class-name test is adk-js's own: it pins the rung this change added
 * to `errorCodeOf`, which the reference covers only inside its other tests.
 */

import {describe, expect, it} from 'vitest';
import {Event} from '../../src/events/event.js';
import {node} from '../../src/workflow/node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow, FnNode, runFailingChildNode} from './test_helpers.js';

function errorEvents(events: Event[]): Event[] {
  return events.filter((e) => e.errorCode !== undefined);
}

describe('node_runner — error events on failure', () => {
  it('test_error_event_emitted_on_failure', async () => {
    const nodeA = node(() => 'Executing A', {name: 'NodeA'});
    const flaky = node(
      () => {
        throw new Error('Something went wrong');
      },
      {name: 'FlakyNode'},
    );
    const wf = new Workflow({
      name: 'test_error_event',
      edges: [
        ['START', nodeA],
        [nodeA, flaky],
      ],
    });

    const {error, events} = await runFailingChildNode(wf, {input: 'start'});
    const failed = errorEvents(events);

    expect((error as Error).message).toBe('Something went wrong');

    expect(failed).toHaveLength(1);
    expect(failed[0].author).toBe('FlakyNode');
    expect(failed[0].errorCode).toBe('Error');
    expect(failed[0].errorMessage).toBe('Something went wrong');
  });

  it('test_error_event_emitted_on_each_retry', async () => {
    // One error instance reused across attempts, as the reference does: each
    // attempt must still report, rather than being deduplicated by identity.
    const transient = new Error('Transient error');
    let attempts = 0;
    const flaky = node(
      () => {
        attempts++;
        if (attempts < 3) {
          throw transient;
        }
        return 'Success';
      },
      {
        name: 'FlakyNode',
        retryConfig: {maxAttempts: 3, initialDelay: 0, jitter: 0},
      },
    );
    const wf = new Workflow({
      name: 'test_error_event_retry',
      edges: [['START', flaky]],
    });

    const {events, output} = await driveWorkflow(wf, 'start');
    const failed = errorEvents(events);

    expect(failed).toHaveLength(2);
    expect(failed.map((e) => e.errorMessage)).toEqual([
      'Transient error',
      'Transient error',
    ]);
    // The node still produces its output after the retries.
    expect(output).toBe('Success');
  });

  it('codes a failure by its error class name when it carries no code', async () => {
    const errNode = new FnNode('ErrNode', () => {
      throw new RangeError('boom');
    });

    const {events} = await runFailingChildNode(errNode);
    const failed = errorEvents(events);

    expect(failed).toHaveLength(1);
    expect(failed[0].errorCode).toBe('RangeError');
  });
});
