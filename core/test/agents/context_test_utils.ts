/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, InvocationContext} from '@google/adk';

/**
 * Builds a `Context` over `sessionState`, for a test that drives a tool
 * directly rather than through a runner.
 *
 * `Context` reads only the session state and the abort signal off its
 * invocation context, so the rest is left out instead of standing up a runner,
 * an agent and a session service. The cast is the one place that shortcut is
 * taken; keep it here rather than in each test.
 *
 * A `functionCallId` is always set, because `requestCredential` needs one to
 * record an authorization request against.
 *
 * @param sessionState The state the context reads and writes. Pass the same
 *   object to two contexts to model two calls in one session.
 * @return The context to hand to `runAsync`.
 */
export function createToolContext(
  sessionState: Record<string, unknown> = {},
): Context {
  const invocationContext = {
    abortSignal: new AbortController().signal,
    session: {state: sessionState},
  } as unknown as InvocationContext;
  return new Context({invocationContext, functionCallId: 'function-call-1'});
}
