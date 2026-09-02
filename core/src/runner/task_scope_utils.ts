/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isBaseAgent} from '../agents/base_agent.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {Event} from '../events/event.js';
import {getFunctionResponses} from '../models/llm_response.js';
import {Session} from '../sessions/session.js';
import {
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
} from '../tools/finish_task_tool.js';
import type {BaseNode} from '../workflow/base_node.js';
import type {RunnableRoot} from '../workflow/run_node_as_invocation.js';
import {isWorkflow} from '../workflow/workflow.js';

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
 *
 * One deliberate divergence from the reference. adk-python reads every
 * isolation scope as a task delegation, because delegation is the only thing
 * that opens one there. In adk-js any node may declare `isolationScope`
 * (`workflow/base_node.ts`), and such a node never emits `finish_task`, so its
 * scope would read as open forever and capture every later user turn into the
 * invocation that opened it. Only scopes a task-mode agent wrote into count,
 * which is what `taskAgentNames` is for.
 *
 * @param taskAgentNames The task-mode agents under the runner's root, from
 *   {@link findTaskAgentNames}. An empty set means no scope can be a task.
 */
export function findActiveTaskScope(
  session: Session,
  taskAgentNames: ReadonlySet<string>,
): TaskScope | undefined {
  const {closed, taskScopes} = scanScopes(session.events, taskAgentNames);
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    const scope = event.isolationScope;
    if (scope && taskScopes.has(scope) && !closed.has(scope)) {
      return {isolationScope: scope, invocationId: event.invocationId};
    }
  }
  return undefined;
}

/**
 * The names of the task-mode agents reachable from `root`.
 *
 * Walks the agent tree through `subAgents` and a workflow through the nodes of
 * its static graph. A node a `dynamicEntry` builds at run time is not visible
 * here, so a task agent reachable only that way is not recognised as one.
 */
export function findTaskAgentNames(root: RunnableRoot): ReadonlySet<string> {
  const names = new Set<string>();
  const seen = new Set<BaseNode>();
  const pending: BaseNode[] = [root];
  for (let i = 0; i < pending.length; i++) {
    const current = pending[i];
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (isLlmAgent(current) && current.mode === 'task') {
      names.add(current.name);
    }
    if (isBaseAgent(current)) {
      pending.push(...current.subAgents);
    }
    if (isWorkflow(current)) {
      pending.push(...(current.graph?.nodes ?? []));
    }
  }
  return names;
}

/**
 * Collects the scopes a task agent wrote into, and the ones a terminal
 * `finish_task` response has closed.
 *
 * This forward pass is what makes the backward search above correct. Events
 * commonly follow the closing response inside the same scope, and a backward
 * search would reach one of those first and read the finished task as still
 * active.
 */
function scanScopes(
  events: Event[],
  taskAgentNames: ReadonlySet<string>,
): {closed: Set<string>; taskScopes: Set<string>} {
  const closed = new Set<string>();
  const taskScopes = new Set<string>();
  for (const event of events) {
    const scope = event.isolationScope;
    if (!scope) {
      continue;
    }
    if (event.author && taskAgentNames.has(event.author)) {
      taskScopes.add(scope);
    }
    if (closesTaskScope(event)) {
      closed.add(scope);
    }
  }
  return {closed, taskScopes};
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
