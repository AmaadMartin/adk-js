/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single decision a resumed workflow makes about each node: execute its
 * body, or hand back what the session already records.
 *
 * Ported from `google/adk-python` `workflow/utils/_replay_interceptor.py`.
 * Python's `create_mock_context` is not ported: it fakes a live `Context` for a
 * node that never ran, whereas adk-js hands back a bare {@link NodeResult}
 * built by {@link interceptedResult} — the honest type for "cached output, no
 * behaviour".
 */

import type {BaseNode} from '../base_node.js';
import type {RouteValue} from '../graph.js';
import type {NodeContext, NodeResult} from '../node_context.js';
import type {RehydratedNode} from './rehydration_utils.js';
import {isFastForwardable} from './rehydration_utils.js';

/** What a resumed workflow should do with one node. */
export interface InterceptionResult {
  /** Whether the node must execute its body. */
  shouldRun: boolean;
  /** The recorded output to hand back, when `shouldRun` is false. */
  output?: unknown;
  /** The recorded route to hand back, when `shouldRun` is false. */
  route?: RouteValue | RouteValue[];
  /** The branch the recorded run was on. */
  branch?: string;
}

/**
 * Decides whether `node` executes, or is replayed from `prior`.
 *
 * @param params.node The node about to be scheduled.
 * @param params.prior The node's recovered run, if the session records one.
 * @param params.resumeInputs Interrupt responses available to this turn, keyed
 *   by interrupt id. Read instead of `prior.resolvedResponses` because a caller
 *   may supply a response the session does not carry.
 */
export function checkInterception(params: {
  node: BaseNode;
  prior?: RehydratedNode;
  resumeInputs: Record<string, unknown>;
}): InterceptionResult {
  const {node, prior, resumeInputs} = params;

  if (!prior) {
    return {shouldRun: true};
  }

  // Completed in a prior turn: hand back the cached result. `rerunOnResume`
  // governs an interrupt the node is still waiting on, not a run that already
  // produced its result, and `isFastForwardable` excludes a waiting node — so
  // the flag is not consulted here.
  if (isFastForwardable(prior)) {
    return {
      shouldRun: false,
      output: prior.output,
      route: prior.route,
      branch: prior.branch,
    };
  }

  // Interrupted in a prior turn and now answered: a node that does not re-run
  // completes with the resolved response(s) as its output, feeding the next
  // node. This is the two-node request-input pattern, where one node asks and
  // its successor receives the human's reply as input.
  if (
    !node.rerunOnResume &&
    prior.output === undefined &&
    prior.interruptIds.size > 0
  ) {
    const values = [...prior.interruptIds].map((id) => resumeInputs[id]);
    if (values.every((value) => value !== undefined)) {
      return {
        shouldRun: false,
        output: values.length === 1 ? values[0] : values,
        branch: prior.branch,
      };
    }
  }

  return {shouldRun: true};
}

/**
 * The result an intercepted node hands back: its body is not re-run and its
 * events are NOT re-emitted (they already exist in the session), so this is a
 * bare {@link NodeResult} rather than a live {@link NodeContext}.
 *
 * `interruptIds` is always empty: a node still blocked on an interrupt is never
 * intercepted, it re-runs.
 */
export function interceptedResult(
  parent: NodeContext,
  decision: InterceptionResult,
): NodeResult {
  return {
    output: decision.output,
    route: decision.route,
    branch: decision.branch ?? parent.branch,
    interruptIds: [],
  };
}
