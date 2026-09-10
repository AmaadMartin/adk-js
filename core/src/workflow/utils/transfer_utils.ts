/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseAgent} from '../../agents/base_agent.js';
import {isLlmAgent} from '../../agents/llm_agent.js';
import type {NodeContext} from '../node_context.js';

/**
 * Longest parent chain any walk here follows, so a malformed agent or context
 * tree cannot hang the run. Mirrors `_MAX_PARENT_DEPTH` in
 * `google/adk-python` `agents/context.py`.
 */
export const MAX_PARENT_DEPTH = 50;

/** Parameters for {@link resolveAndDeriveTransferContext}. */
export interface ResolveTransferParams {
  /** Name of the agent the current agent asked to transfer to. */
  targetName: string;
  /** The agent that requested the transfer. */
  currentAgent: BaseAgent;
  /** Root of the agent tree the target is looked up in. */
  rootAgent: BaseAgent;
  /** The context the current agent just ran in. */
  currCtx: NodeContext;
  /** The context that ran {@link currCtx}. */
  currParentCtx: NodeContext;
}

/** Where a transfer resolves to. */
export interface TransferResolution {
  /** The agent to run next. */
  targetAgent: BaseAgent;
  /** The context that agent runs under. */
  nextParentCtx: NodeContext;
}

/**
 * Resolves an agent transfer to its target agent and the context that target
 * runs under.
 *
 * Ported from `google/adk-python`
 * `workflow/utils/_transfer_utils.py::resolve_and_derive_transfer_context`.
 * The relationship between the two agents decides where the target runs: a
 * child nests under the caller's own context, a sibling reuses the caller's
 * parent context, and a parent climbs the context chain back to the context
 * that ran it.
 *
 * @return The target and the context it runs under.
 * @throws Error When the tree holds no agent of that name, when the target is
 *     the current agent, when the current agent forbids the transfer, or when
 *     the two agents have no routing relationship.
 */
export function resolveAndDeriveTransferContext({
  targetName,
  currentAgent,
  rootAgent,
  currCtx,
  currParentCtx,
}: ResolveTransferParams): TransferResolution {
  const targetAgent = rootAgent.findAgent(targetName);
  if (!targetAgent) {
    throw new Error(`Transfer target agent '${targetName}' not found.`);
  }

  if (targetAgent.name === currentAgent.name) {
    throw new Error(`Agent '${targetName}' cannot transfer to itself.`);
  }

  if (targetAgent.parentAgent?.name === currentAgent.name) {
    return {targetAgent, nextParentCtx: currCtx};
  }

  if (
    targetAgent.parentAgent &&
    currentAgent.parentAgent &&
    targetAgent.parentAgent.name === currentAgent.parentAgent.name
  ) {
    if (isLlmAgent(currentAgent) && currentAgent.disallowTransferToPeers) {
      throw new Error(
        `Cannot transfer from '${currentAgent.name}' to peer agent ` +
          `'${targetName}': disallowTransferToPeers is set.`,
      );
    }
    return {targetAgent, nextParentCtx: currParentCtx};
  }

  if (currentAgent.parentAgent?.name === targetAgent.name) {
    if (isLlmAgent(currentAgent) && currentAgent.disallowTransferToParent) {
      throw new Error(
        `Cannot transfer from '${currentAgent.name}' to parent agent ` +
          `'${targetName}': disallowTransferToParent is set.`,
      );
    }
    const nextParentCtx = contextThatRan(currCtx, targetName);
    if (nextParentCtx) {
      return {targetAgent, nextParentCtx};
    }
  }

  throw new Error(
    `Cannot transfer from '${currentAgent.name}' to unrelated agent ` +
      `'${targetName}'.\nAvailable agents: ` +
      `${agentNamesInTree(rootAgent).join(', ')}`,
  );
}

/**
 * Walks up from `ctx` to the context that ran the node named `targetName`, and
 * returns the context that in turn ran *that* one — the context a transfer to
 * the parent agent must resume under.
 *
 * Falls back to the outermost context of the walk when no context on the chain
 * belongs to the target, which is what a root coordinator or a bypassed parent
 * looks like.
 */
function contextThatRan(
  ctx: NodeContext,
  targetName: string,
): NodeContext | undefined {
  let curr: NodeContext | undefined = ctx;
  for (let depth = 0; curr?.node && depth < MAX_PARENT_DEPTH; depth++) {
    if (curr.node.name === targetName) {
      return curr.parentCtx;
    }
    curr = curr.parentCtx;
  }

  let outermost = ctx;
  for (
    let depth = 0;
    outermost.node && outermost.parentCtx && depth < MAX_PARENT_DEPTH;
    depth++
  ) {
    outermost = outermost.parentCtx;
  }
  return outermost;
}

/**
 * Every agent name in the tree rooted at `agent`, depth first, for an error
 * message that tells the caller which names it could have used.
 */
function agentNamesInTree(agent: BaseAgent): string[] {
  return [agent.name, ...agent.subAgents.flatMap(agentNamesInTree)];
}
