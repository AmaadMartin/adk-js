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
 *
 * The last suite covers the native-event guard. Those cases are adk-js's own
 * too — adk-python has no equivalent, because its framework overwrites an
 * event's author.
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {
  isNodeErrorEvent,
  NodeErrorEvent,
} from '../../src/workflow/node_error_event.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {
  driveWorkflow,
  FnNode,
  GenNode,
  runChildNode,
  runFailingChildNode,
} from './test_helpers.js';

function errorEvents(events: Event[]): Event[] {
  return events.filter((e) => e.errorCode !== undefined);
}

/** The same events, typed, for an assertion that reads a node-error field. */
function nodeErrorEvents(events: Event[]): NodeErrorEvent[] {
  return events.filter(isNodeErrorEvent);
}

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

  it('emits one event per attempt when every attempt throws the same error', async () => {
    // Not in the reference, where each attempt raises a fresh exception. A
    // node that rethrows one cached error object is the case that decides
    // whether a retried attempt may claim the error: claiming it here would
    // leave the later attempts, and the terminal report, with nothing to say.
    const shared = new CustomRetryableError('Transient error');
    let attempts = 0;
    const flaky = new FnNode(
      'FlakyNode',
      () => {
        attempts += 1;
        throw shared;
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

    const {error, events} = await runFailingChildNode(flaky);

    expect(attempts).toBe(3);
    expect(nodeErrorEvents(events)).toHaveLength(3);
    expect(nodeErrorEvents(events).map((e) => e.attemptCount)).toEqual([
      1, 2, 3,
    ]);
    expect(error).toBe(shared);
  });

  it('test_node_runner_prefers_api_status_for_error_code', async () => {
    const errNode = new FnNode('ErrNode', () => {
      throw new ClientError();
    });

    const {events} = await runFailingChildNode(errNode);
    const failed = errorEvents(events);

    expect(failed).toHaveLength(1);
    // The string `.status` wins over the numeric `.code` beside it.
    expect(failed[0].errorCode).toBe('PERMISSION_DENIED');
    expect(failed[0].errorMessage).toContain(
      'Egress request is not authorized',
    );
  });

  it('test_node_runner_falls_back_to_class_name_without_status', async () => {
    const errNode = new FnNode('ErrNode', () => {
      throw new ValueError('boom');
    });

    const {events} = await runFailingChildNode(errNode);
    const failed = nodeErrorEvents(events);

    expect(failed).toHaveLength(1);
    expect(failed[0].errorType).toBe('ValueError');
    expect(failed[0].errorCode).toBe('ValueError');
  });

  it('test_node_runner_numeric_status_falls_through_to_code', async () => {
    // adk-python's `isinstance(status, str)` guard is there for a client whose
    // `.status` is an HTTP number. This pins that the port kept the guard
    // rather than stringifying whatever `.status` holds.
    const errNode = new FnNode('ErrNode', () => {
      throw Object.assign(new Error('gateway timeout'), {
        status: 504,
        code: 'ETIMEDOUT',
      });
    });

    const {events} = await runFailingChildNode(errNode);
    const failed = errorEvents(events);

    expect(failed).toHaveLength(1);
    expect(failed[0].errorCode).toBe('ETIMEDOUT');
  });
  it('reports a plain error without a status or code', async () => {
    // The reference's own fallback is `UNKNOWN_ERROR`; adk-js reaches the
    // class-name rung first, so a plain `Error` codes as `Error`.
    const errNode = new FnNode('ErrNode', () => {
      throw new Error('no code');
    });

    const {events} = await runFailingChildNode(errNode);
    const failed = nodeErrorEvents(events);

    expect(failed).toHaveLength(1);
    expect(failed[0].errorType).toBe('Error');
    expect(failed[0].errorCode).toBe('Error');
  });
});

describe('node_runner \u2014 only the node\u2019s own events decide route and transfer', () => {
  it('adopts a route from an event the node authored', async () => {
    const n = new GenNode('mine', async function* () {
      yield createEvent({author: 'mine', route: 'branch_a'});
    });

    const {child} = await runChildNode(n);

    expect(child.route).toBe('branch_a');
  });

  it('ignores a route from an event a sub-agent authored', async () => {
    const n = new GenNode('parent', async function* () {
      yield createEvent({author: 'sub_agent', route: 'branch_a'});
    });

    const {child} = await runChildNode(n);

    expect(child.route).toBeUndefined();
  });

  it('adopts transferToAgent from an event the node authored', async () => {
    const n = new GenNode('mine', async function* () {
      yield createEvent({
        author: 'mine',
        actions: {transferToAgent: 'specialist'},
      });
    });

    const {child} = await runChildNode(n);

    expect(child.actions.transferToAgent).toBe('specialist');
  });

  it('ignores transferToAgent from an event a sub-agent authored', async () => {
    const n = new GenNode('parent', async function* () {
      yield createEvent({
        author: 'sub_agent',
        actions: {transferToAgent: 'specialist'},
      });
    });

    const {child} = await runChildNode(n);

    expect(child.actions.transferToAgent).toBeUndefined();
  });

  it('treats an unauthored event as the node\u2019s own', async () => {
    const n = new GenNode('anon', async function* () {
      yield createEvent({route: 'branch_a'});
    });

    const {child} = await runChildNode(n);

    expect(child.route).toBe('branch_a');
  });

  it('sets the output from a messageAsOutput event that carries none', async () => {
    const n = new GenNode('speaker', async function* (_ctx: NodeContext) {
      yield createEvent({
        content: {role: 'model', parts: [{text: 'the answer'}]},
        nodeInfo: {messageAsOutput: true},
      });
    });

    const {child} = await runChildNode(n);

    expect(child.output).toEqual({
      role: 'model',
      parts: [{text: 'the answer'}],
    });
  });
});
