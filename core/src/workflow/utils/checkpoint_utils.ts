/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../../events/event.js';
import {NodeState} from '../node_state.js';
import {NodeStatus} from '../node_status.js';

/**
 * One node's entry in a {@link WorkflowAgentState} snapshot.
 *
 * `status` carries the numeric {@link NodeStatus} wire value, which is what
 * adk-python's `NodeState.model_dump(mode='json')` writes for its own
 * int-valued `NodeStatus` enum.
 */
export interface WorkflowNodeCheckpoint {
  status: NodeStatus;
  interrupts: string[];
}

/**
 * A `Workflow`'s resumption checkpoint, as it is persisted on
 * `EventActions.agentState`.
 *
 * The shape mirrors adk-python's `Workflow._emit_node_checkpoint` payload so a
 * session one runtime writes stays readable by the other. The key `nodes` does
 * not collide with the `{input}` stash the node runner writes on an interrupt
 * event; both may appear on one stream.
 */
export type WorkflowAgentState = {
  nodes: Record<string, WorkflowNodeCheckpoint>;
};

/**
 * Snapshots the workflow's node statuses for persistence.
 *
 * `resumeInputs` is deliberately left out: for a node guarded by an auth config
 * those hold the credential the user sent, and a resume rebuilds them from the
 * function responses already in the session.
 */
export function buildWorkflowAgentState(
  nodes: ReadonlyMap<string, NodeState>,
): WorkflowAgentState {
  const snapshot: Record<string, WorkflowNodeCheckpoint> = {};
  for (const [name, state] of nodes) {
    snapshot[name] = {status: state.status, interrupts: [...state.interrupts]};
  }
  return {nodes: snapshot};
}

/** Provenance shared by every event a workflow emits about its own progress. */
export interface WorkflowEventOrigin {
  author: string;
  invocationId: string;
  branch?: string;
}

/** Builds the checkpoint event recording how far the workflow has got. */
export function createNodeCheckpointEvent(
  origin: WorkflowEventOrigin,
  nodes: ReadonlyMap<string, NodeState>,
): Event {
  return createEvent({
    ...origin,
    actions: {agentState: buildWorkflowAgentState(nodes)},
  });
}

/** Builds the marker event recording that the workflow ran to completion. */
export function createEndOfAgentEvent(origin: WorkflowEventOrigin): Event {
  return createEvent({...origin, actions: {endOfAgent: true}});
}

/**
 * Builds the event that re-surfaces a fast-forwarded node's cached output, so a
 * resumable stream still records the value the node produced.
 *
 * Marked `replayed`, because no node ran to produce it. Rehydration skips it;
 * unmarked, a later resume reads it as another run of that node and hands a
 * fresh activation a stale output.
 */
export function createReplayedOutputEvent(
  origin: WorkflowEventOrigin,
  nodePath: string,
  output: unknown,
): Event {
  return createEvent({
    ...origin,
    output,
    nodeInfo: {path: nodePath, replayed: true},
  });
}
