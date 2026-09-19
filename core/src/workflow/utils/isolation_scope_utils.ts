/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Task-mode scheduling and conversation isolation for workflow graph nodes.
 *
 * Ported from `google/adk-python` `workflow/_workflow.py`
 * (`_has_waiting_task_agent`, `_compute_isolation_scope_for_node`).
 */

import {isLlmAgent} from '../../agents/llm_agent.js';
import {BaseNode} from '../base_node.js';
import {Graph} from '../graph.js';
import {NodeState} from '../node_state.js';
import {NodeStatus} from '../node_status.js';
import {Trigger} from '../trigger.js';

/** Whether `node` is an agent that runs as a multi-turn task. */
export function isTaskModeNode(node: BaseNode): boolean {
  return isLlmAgent(node) && node.mode === 'task';
}

/**
 * Whether any task-mode agent node in the graph is currently `WAITING`.
 *
 * A task-mode agent may need several user turns to finish. While one is
 * mid-task the graph holds, so a peer node does not join a conversation that
 * is still in progress.
 */
export function hasWaitingTaskAgent(
  graph: Graph,
  nodes: ReadonlyMap<string, NodeState>,
): boolean {
  return graph.nodes.some(
    (node) =>
      isTaskModeNode(node) &&
      nodes.get(node.name)?.status === NodeStatus.WAITING,
  );
}

/**
 * The isolation scope a node about to run reads and writes its turns under.
 *
 * A trigger that names a scope wins, so a replayed run continues in the scope
 * it first ran under. Otherwise a task-mode agent gets a scope of its own: it
 * holds a multi-turn conversation, and without one it reads every peer node's
 * turns as if they were its own. The scope carries the whole node path, not
 * just the name, so two nested workflows that reuse a node name stay apart.
 *
 * The scope is derived once and then held on the node state. A graph that
 * routes back to a task agent runs it again under a new run id, and re-deriving
 * the scope there would leave the agent reading none of its own earlier turns:
 * an event is visible only inside the scope it was written under. adk-python
 * does re-derive it, and compensates in its content filter, which excludes
 * untagged events and rebuilds the agent's opening turn. adk-js keeps untagged
 * events shared, so the same scope carried forward is what gives the agent a
 * whole conversation.
 *
 * A node that declares its own `isolationScope` keeps it. That declaration is
 * an adk-js feature with no counterpart in the reference, and the node runner
 * already applies it, so this returns nothing and lets it through.
 */
export function isolationScopeForNode(
  node: BaseNode,
  trigger: Trigger,
  nodeState: NodeState,
  nodePath: string,
  runId: string,
): string | undefined {
  if (trigger.isolationScope !== undefined) {
    return trigger.isolationScope;
  }
  if (!isTaskModeNode(node) || node.isolationScope !== undefined) {
    return undefined;
  }
  nodeState.isolationScope ??= `${nodePath}@${runId}`;
  return nodeState.isolationScope;
}
