/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isBaseAgent} from '../agents/base_agent.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {Event, getFunctionResponses} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
} from '../tools/finish_task_tool.js';
import {BaseNode} from '../workflow/base_node.js';
import type {RunnableRoot} from '../workflow/run_node_as_invocation.js';
import {isWorkflow} from '../workflow/workflow.js';

/**
 * The isolation scope of the task delegation that is still in flight, if any.
 *
 * A task agent runs inside an isolation scope, and every event it emits carries
 * that scope. The scope closes on a terminal `finish_task` response; a response
 * carrying an error leaves it open, because the task agent sees the error and
 * retries.
 *
 * `taskAgentNames` is what makes the answer safe here. adk-python can treat
 * every isolation scope as a task delegation, because delegation is the only
 * thing that opens one. In this SDK any node may declare `isolationScope`, and
 * such a node never emits `finish_task`, so its scope would look open forever.
 * Only a scope some task agent wrote into is considered.
 *
 * The finished scopes are collected in a forward pass first. Walking backward
 * directly would reach the events that follow a terminal `finish_task` before
 * the response itself, and report a closed scope as active.
 */
export function findActiveTaskScope(
  session: Session,
  taskAgentNames: ReadonlySet<string>,
): {isolationScope: string; invocationId: string} | undefined {
  if (!taskAgentNames.size) {
    return undefined;
  }

  const taskScopes = new Set<string>();
  const finishedScopes = new Set<string>();
  for (const event of session.events) {
    const scope = event.isolationScope;
    if (!scope) {
      continue;
    }
    if (event.author && taskAgentNames.has(event.author)) {
      taskScopes.add(scope);
    }
    if (closesTaskScope(event)) {
      finishedScopes.add(scope);
    }
  }

  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    const scope = event.isolationScope;
    if (scope && taskScopes.has(scope) && !finishedScopes.has(scope)) {
      return {isolationScope: scope, invocationId: event.invocationId};
    }
  }
  return undefined;
}

/**
 * The names of the task-mode agents reachable from `root`, through both
 * sub-agent trees and workflow graphs.
 */
export function findTaskAgentNames(root: RunnableRoot): ReadonlySet<string> {
  const names = new Set<string>();
  const seen = new Set<BaseNode>();
  const pending: BaseNode[] = [root];
  while (pending.length) {
    const current = pending.pop()!;
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

/** Whether the event carries a terminal `finish_task` response. */
function closesTaskScope(event: Event): boolean {
  for (const response of getFunctionResponses(event)) {
    if (response.name !== FINISH_TASK_TOOL_NAME) {
      continue;
    }
    const result = response.response?.['result'];
    return (
      result === FINISH_TASK_SUCCESS_RESULT ||
      result === FINISH_TASK_ERROR_RESULT
    );
  }
  return false;
}
