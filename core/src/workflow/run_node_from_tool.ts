/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';

import {BaseNode} from './base_node.js';
import {createSubBranch} from './branch_path.js';
import {NodeContext} from './node_context.js';
import {executeChildNode} from './node_runner.js';

/**
 * Maximum nesting depth for node-as-tool executions, guarding against
 * `node -> tool -> node` recursion (a node exposed as a tool whose agent can
 * call that same tool again — unbounded model + tool spend otherwise).
 */
const MAX_NODE_TOOL_DEPTH = 8;

/** Parameters for {@link runNodeFromToolContext}. */
export interface RunNodeFromToolParams {
  /** The tool context of the call requesting the child run. */
  toolContext: Context;
  /** The node to run. An agent is a node, so it goes in as itself. */
  node: BaseNode;
  /** The input handed to the node. */
  input: unknown;
  /** The calling tool's name: the branch segment, and quoted in the errors. */
  toolName: string;
}

/**
 * Runs `node` with a {@link NodeContext} bridged from a tool call's context.
 *
 * Node events stream into the invocation's event queue so intermediate and
 * interrupt events surface to the agent, and a paused node can be resumed. The
 * caller must therefore be an `LlmAgent` tool-call step, which is what supplies
 * that queue and the function-call id.
 */
export function runNodeFromToolContext({
  toolContext,
  node,
  input,
  toolName,
}: RunNodeFromToolParams): Promise<NodeContext> {
  const ic = toolContext.invocationContext;

  // A paused node's interrupt event must reach the session, so an event queue
  // is required; without one the pause would be a silent dead end.
  const channel = ic.eventQueue;
  if (!channel) {
    throw new Error(
      `Tool '${toolName}' requires an invocation event queue; ` +
        'it must be invoked from an LlmAgent tool-call step.',
    );
  }

  // A stable, unique run id per tool call: reused across resume so the paused
  // run can be matched. (A shared fallback would collapse distinct calls.)
  const runId = toolContext.functionCallId;
  if (!runId) {
    throw new Error(
      `Tool '${toolName}' requires a function-call id; ` +
        'it must be invoked from an LlmAgent tool-call step.',
    );
  }

  if (ic.nodeToolDepth >= MAX_NODE_TOOL_DEPTH) {
    throw new Error(
      `Tool '${toolName}': node-tool nesting exceeded ` +
        `${MAX_NODE_TOOL_DEPTH} (possible node -> tool -> node recursion).`,
    );
  }
  // Run the node (and anything it reaches) at depth+1 so the guard above trips
  // on unbounded recursion; the clone carries the depth across agent runs.
  const childIc = ic.clone({nodeToolDepth: ic.nodeToolDepth + 1});

  const nodeCtx = new NodeContext({
    invocationContext: childIc,
    channel,
    // Empty so executeChildNode's path is a single segment (the node name),
    // not the node name doubled.
    nodePath: '',
    runId,
    resumeInputs: collectResumeInputs(toolContext),
  });

  return executeChildNode({
    parent: nodeCtx,
    node,
    input,
    options: {
      runId,
      overrideBranch: createSubBranch(childIc.branch, {name: toolName, runId}),
    },
  });
}

/**
 * Collects resume inputs for the node from the tool context. When the tool call
 * is being resumed after a `RequestInput`, the user's response is threaded
 * through `toolConfirmation.payload` keyed by interrupt id (see the request-input
 * resume processor).
 */
function collectResumeInputs(toolContext: Context): Record<string, unknown> {
  const payload = toolContext.toolConfirmation?.payload;
  if (payload && typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return {};
}
