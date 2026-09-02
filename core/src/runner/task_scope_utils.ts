/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, getFunctionResponses} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
} from '../tools/finish_task_tool.js';

/**
 * The isolation scope of a task agent that is paused waiting for the user, and
 * the invocation that task belongs to.
 */
export interface TaskScope {
  /** The scope tag the task agent's events carry. */
  isolationScope: string;
  /** The invocation the paused task is part of. */
  invocationId: string;
}

/**
 * Finds the isolation scope of the task agent that is paused waiting for the
 * user's next reply, if there is one.
 *
 * A task agent runs behind an isolation scope so peer scopes do not see each
 * other's events. Two flavours open one:
 *
 * - Function-call delegation, where a chat coordinator hands work to a task
 *   agent and the scope is the function call's id.
 * - A workflow node, where a task-mode agent dispatched as a node stamps
 *   `<nodeName>@<runId>` on everything it emits.
 *
 * Either closes on a `finish_task` function response whose `result` is
 * {@link FINISH_TASK_SUCCESS_RESULT} or {@link FINISH_TASK_ERROR_RESULT}. A
 * response carrying an `error` key is a tool validation failure and does not
 * close the scope: the task agent sees the error and retries.
 *
 * The runner uses the answer to stamp a new user message with the paused task's
 * scope, so the reply reaches the task agent instead of being filtered out of
 * its view. Ported from `google/adk-python`
 * `runners.py::_find_active_task_scope`.
 */
export function findActiveTaskScope(session: Session): TaskScope | undefined {
  const closed = closedScopes(session.events);
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    const scope = event.isolationScope;
    if (scope && !closed.has(scope)) {
      return {isolationScope: scope, invocationId: event.invocationId};
    }
  }
  return undefined;
}

/**
 * Collects every scope a terminal `finish_task` response has closed.
 *
 * This forward pass is what makes the backward search above correct. Events
 * commonly follow the closing response inside the same scope, and a backward
 * search would reach one of those first and read the finished task as still
 * active.
 */
function closedScopes(events: Event[]): Set<string> {
  const closed = new Set<string>();
  for (const event of events) {
    if (event.isolationScope && closesTaskScope(event)) {
      closed.add(event.isolationScope);
    }
  }
  return closed;
}

/** Whether an event carries a terminal `finish_task` function response. */
function closesTaskScope(event: Event): boolean {
  return getFunctionResponses(event).some((fr) => {
    if (fr.name !== FINISH_TASK_TOOL_NAME) {
      return false;
    }
    const result = (fr.response as {result?: unknown} | undefined)?.result;
    return (
      result === FINISH_TASK_SUCCESS_RESULT ||
      result === FINISH_TASK_ERROR_RESULT
    );
  });
}
