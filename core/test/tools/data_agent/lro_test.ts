/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `_await_lro` cases of adk-python@main
 * `tests/unittests/tools/data_agent/test_data_agent_tool.py`. They live here
 * rather than beside the tool tests because the polling loop is its own
 * module. The ported cases keep their Python names.
 *
 * adk-python drives time through a `_FakeClock` fixture that patches
 * `time.monotonic` and `asyncio.sleep`. {@link FakeClock} is the same idea, so
 * a 60-second timeout is exercised instantly.
 */

import {describe, expect, it} from 'vitest';
// Not part of the public entry point: the tools are its only caller, so the
// polling loop is imported from the source it lives in.
import {awaitLro} from '../../../src/tools/data_agent/lro.js';
import {
  AGENT_NAME,
  connectionError,
  DEFAULT_ENDPOINT,
  errorOf,
  errorResponse,
  FakeClock,
  FakeGdaSession,
  finishedOperation,
  jsonResponse,
  OPERATION_NAME,
  runningOperation,
  successOf,
} from './data_agent_test_utils.js';

/** Runs `awaitLro` over `session` on a clock only sleeping advances. */
function pollWith(
  session: FakeGdaSession,
  clock: FakeClock,
  initial: ReturnType<typeof jsonResponse>,
  overrides: {deadline?: number; pollIntervalSeconds?: number} = {},
) {
  return awaitLro({
    session,
    baseUrl: `${DEFAULT_ENDPOINT}/v1`,
    headers: {},
    response: initial,
    deadline: overrides.deadline ?? 100,
    pollIntervalSeconds: overrides.pollIntervalSeconds ?? 0.1,
    totalTimeoutSeconds: 60,
    clock,
  });
}

describe('awaitLro, ported from test_data_agent_tool.py', () => {
  it('test_await_lro_returns_immediately_when_done', async () => {
    const session = new FakeGdaSession();
    const result = await pollWith(
      session,
      new FakeClock(),
      finishedOperation({name: AGENT_NAME}),
      {pollIntervalSeconds: 2},
    );

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
    expect(session.requests).toEqual([]);
  });

  it('test_await_lro_non_operation_name_returns_immediately', async () => {
    const session = new FakeGdaSession();
    const result = await pollWith(
      session,
      new FakeClock(),
      jsonResponse({name: AGENT_NAME}),
      {pollIntervalSeconds: 2},
    );

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
    expect(session.requests).toEqual([]);
  });

  it('test_await_lro_polls_until_done', async () => {
    const session = new FakeGdaSession().respond(
      runningOperation(),
      finishedOperation({name: AGENT_NAME}),
    );

    const result = await awaitLro({
      session,
      baseUrl: `${DEFAULT_ENDPOINT}/v1`,
      headers: {'X-Test': '1'},
      response: runningOperation(),
      deadline: 100,
      pollIntervalSeconds: 0.1,
      totalTimeoutSeconds: 60,
      clock: new FakeClock(),
    });

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
    expect(session.requests).toHaveLength(2);
    expect(session.lastRequest()).toMatchObject({
      url: `${DEFAULT_ENDPOINT}/v1/${OPERATION_NAME}`,
      headers: {'X-Test': '1'},
    });
  });

  it('test_await_lro_operation_error', async () => {
    const session = new FakeGdaSession().respond(
      jsonResponse({
        name: OPERATION_NAME,
        done: true,
        error: {code: 400, message: 'Mutation invalid'},
      }),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(errorOf(result)).toContain('Mutation invalid');
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
  });

  it('test_await_lro_poll_http_error', async () => {
    const session = new FakeGdaSession().respond(
      errorResponse(400, 'Bad Request'),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(errorOf(result)).toContain(
      'Polling failed with status: 400 Bad Request',
    );
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
  });

  it.each([429, 500, 502, 503, 504])(
    'test_await_lro_retryable_http_error_recovers [%i]',
    async (code) => {
      const session = new FakeGdaSession().respond(
        errorResponse(code, 'Retryable Error'),
        finishedOperation({name: AGENT_NAME}),
      );

      const result = await pollWith(
        session,
        new FakeClock(),
        runningOperation(),
      );

      expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
      expect(session.requests).toHaveLength(2);
    },
  );

  it('test_await_lro_connection_error_retries_and_recovers', async () => {
    const session = new FakeGdaSession().respond(
      connectionError('Temporary network failure'),
      finishedOperation({name: AGENT_NAME}),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
    expect(session.requests).toHaveLength(2);
  });

  it('test_await_lro_poll_invalid_json', async () => {
    const session = new FakeGdaSession().respond({
      ok: true,
      status: 200,
      text: 'not json',
    });

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(errorOf(result)).toContain('Polling returned invalid JSON');
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
  });

  it('test_await_lro_unpollable_operation_not_done_returns_error', async () => {
    const session = new FakeGdaSession();

    const result = await pollWith(
      session,
      new FakeClock(),
      jsonResponse({name: 'invalid-op-name', done: false}),
    );

    expect(errorOf(result)).toContain(
      'Operation is not completed and does not contain a pollable',
    );
    expect(session.requests).toEqual([]);
  });

  it('test_await_lro_timeout', async () => {
    const clock = new FakeClock();
    const session = new FakeGdaSession().respond(() => {
      clock.seconds += 30;
      return runningOperation();
    });

    const result = await awaitLro({
      session,
      baseUrl: `${DEFAULT_ENDPOINT}/v1`,
      headers: {},
      response: runningOperation(),
      deadline: clock.now() + 10,
      pollIntervalSeconds: 0.1,
      totalTimeoutSeconds: 10,
      clock,
    });

    expect(errorOf(result)).toContain('did not complete within');
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
  });

  it('test_await_lro_poll_network_exception', async () => {
    const session = new FakeGdaSession().respond(
      new Error('Network unreachable'),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(errorOf(result)).toContain('Network unreachable');
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
    expect(session.requests).toHaveLength(1);
  });
});

describe('awaitLro', () => {
  it('reports the mutation status when the mutation itself failed', async () => {
    const result = await pollWith(
      new FakeGdaSession(),
      new FakeClock(),
      errorResponse(500, 'boom'),
    );

    expect(errorOf(result)).toBe('API returned error status: 500 boom');
    expect(result).not.toHaveProperty('operation_name');
  });

  it('reads a finished operation that carries no response field', async () => {
    const operation = {name: OPERATION_NAME, done: true};
    const result = await pollWith(
      new FakeGdaSession(),
      new FakeClock(),
      jsonResponse(operation),
    );

    expect(successOf(result)['response']).toEqual(operation);
  });

  it('gives up on a retryable status once the budget is spent', async () => {
    const session = new FakeGdaSession().respond(errorResponse(503, 'busy'));
    const clock = new FakeClock();

    const result = await pollWith(session, clock, runningOperation(), {
      deadline: 1,
      pollIntervalSeconds: 2,
    });

    expect(errorOf(result)).toContain('Polling failed with status: 503 busy');
    expect(session.requests).toHaveLength(1);
  });

  it('gives up on a dropped connection once the budget is spent', async () => {
    const session = new FakeGdaSession().respond(connectionError('reset'));

    const result = await pollWith(
      session,
      new FakeClock(),
      runningOperation(),
      {
        deadline: 1,
        pollIntervalSeconds: 2,
      },
    );

    expect(errorOf(result)).toContain('Polling failed with exception: reset');
    expect(session.requests).toHaveLength(1);
  });

  it('retries after an aborted request', async () => {
    const session = new FakeGdaSession().respond(
      Object.assign(new Error('timed out'), {name: 'TimeoutError'}),
      finishedOperation({name: AGENT_NAME}),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
  });

  it('reports the timeout without polling when the budget is already spent', async () => {
    const session = new FakeGdaSession();

    const result = await pollWith(
      session,
      new FakeClock(),
      runningOperation(),
      {
        deadline: 0,
      },
    );

    expect(errorOf(result)).toContain('did not complete within');
    expect(session.requests).toEqual([]);
  });

  it('stops after a poll that leaves no budget for another', async () => {
    const clock = new FakeClock();
    const session = new FakeGdaSession().respond(() => {
      clock.seconds += 5;
      return runningOperation();
    });

    const result = await pollWith(session, clock, runningOperation(), {
      deadline: 5,
    });

    expect(errorOf(result)).toContain('did not complete within');
    expect(session.requests).toHaveLength(1);
  });

  it('does not retry a thrown value that carries no error code', async () => {
    const session = new FakeGdaSession().respond(() => {
      throw 'a string, not an Error';
    });

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(errorOf(result)).toContain('Polling failed with exception:');
    expect(session.requests).toHaveLength(1);
  });

  it('answers with a bare success for a body that is not an object', async () => {
    const result = await pollWith(
      new FakeGdaSession(),
      new FakeClock(),
      jsonResponse('finished'),
    );

    expect(successOf(result)['response']).toEqual({});
  });
});

describe('the system clock', () => {
  it('polls a running operation on real time when no clock is injected', async () => {
    const session = new FakeGdaSession().respond(
      runningOperation(),
      finishedOperation({name: AGENT_NAME}),
    );

    const result = await awaitLro({
      session,
      baseUrl: `${DEFAULT_ENDPOINT}/v1`,
      headers: {},
      response: runningOperation(),
      deadline: performance.now() / 1000 + 1,
      pollIntervalSeconds: 0.01,
      totalTimeoutSeconds: 1,
    });

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
    expect(session.requests).toHaveLength(2);
  });
});
