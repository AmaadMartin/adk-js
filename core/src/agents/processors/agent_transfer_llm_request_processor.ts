/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {Event} from '../../events/event.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {isEnterpriseWebSearchTool} from '../../tools/enterprise_web_search_tool.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {isGoogleSearchTool} from '../../tools/google_search_tool.js';
import {isVertexAiSearchTool} from '../../tools/vertex_ai_search_tool.js';
import {BaseAgent} from '../base_agent.js';
import {Context} from '../context.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent, LlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

const TRANSFER_TO_AGENT_TOOL_NAME = 'transfer_to_agent';

/** Agent modes that cannot service a conversation handed to them. */
const NON_TRANSFERABLE_MODES: ReadonlyArray<LlmAgent['mode']> = [
  'single_turn',
  'task',
];

/**
 * Whether `agent` may be offered to the model as a transfer target.
 *
 * A `single_turn` or `task` agent is driven by the workflow graph rather than
 * by a transfer, so it is excluded. Only {@link LlmAgent} carries `mode`; every
 * other agent type is a valid target.
 */
function isTransferTarget(agent: BaseAgent): boolean {
  return !isLlmAgent(agent) || !NON_TRANSFERABLE_MODES.includes(agent.mode);
}

/**
 * Collects the agents that `agent` can transfer to: its sub-agents, its parent
 * agent, and its peer agents, subject to the `disallowTransferTo*` flags.
 *
 * Sub-agents and peers are filtered by {@link isTransferTarget}. The parent is
 * not: returning control upwards is always allowed.
 */
function getTransferTargets(agent: LlmAgent): BaseAgent[] {
  const targets: BaseAgent[] = agent.subAgents.filter(isTransferTarget);

  if (!agent.parentAgent || !isLlmAgent(agent.parentAgent)) {
    return targets;
  }

  if (!agent.disallowTransferToParent) {
    targets.push(agent.parentAgent);
  }

  if (!agent.disallowTransferToPeers) {
    targets.push(
      ...agent.parentAgent.subAgents.filter(
        (peerAgent) =>
          peerAgent.name !== agent.name && isTransferTarget(peerAgent),
      ),
    );
  }

  return targets;
}

function buildTargetAgentInfo(targetAgent: BaseAgent): string {
  return `
Agent name: ${targetAgent.name}
Agent description: ${targetAgent.description}
`;
}

/** Builds the transfer instruction text for `agent`. */
function buildTransferInstructions(
  agent: LlmAgent,
  targetAgents: BaseAgent[],
): string {
  const formattedAgentNames = targetAgents
    .map((target) => target.name)
    .sort()
    .map((name) => `\`${name}\``)
    .join(', ');

  let instructions = `
You have a list of other agents to transfer to:

${targetAgents.map(buildTargetAgentInfo).join('\n')}

If you are the best to answer the question according to your description,
you can answer it.

If another agent is better for answering the question according to its
description, call \`${TRANSFER_TO_AGENT_TOOL_NAME}\` function to transfer the question to that
agent. When transferring, do not generate any text other than the function
call.

**NOTE**: the only available agents for \`${TRANSFER_TO_AGENT_TOOL_NAME}\` function are
${formattedAgentNames}.
`;

  if (agent.parentAgent && !agent.disallowTransferToParent) {
    instructions += `
If neither you nor the other agents are best for the question, transfer to your parent agent ${agent.parentAgent.name}.
`;
  }

  return instructions;
}

function buildSearchToolError(agentName: string, toolClass: string): string {
  return (
    `Agent '${agentName}' has sub-agent transfer targets but is configured ` +
    `with ${toolClass} without bypassMultiToolsLimit: true. Gemini API does ` +
    'not allow built-in search tools to be combined with function calling ' +
    '(agent delegation). To enable both search and sub-agent delegation, set ' +
    'bypassMultiToolsLimit: true on GoogleSearchTool or VertexAiSearchTool.'
  );
}

/**
 * Returns the error message for the first tool on `agent` that the Gemini API
 * refuses to combine with function calling, or `undefined` when there is none.
 *
 * Agent transfer is function calling, so a built-in search tool and a transfer
 * target cannot coexist in one request.
 */
function getIncompatibleBuiltInToolError(agent: LlmAgent): string | undefined {
  for (const tool of agent.tools) {
    if (isGoogleSearchTool(tool) && !tool.bypassMultiToolsLimit) {
      return buildSearchToolError(agent.name, 'GoogleSearchTool');
    }
    if (isVertexAiSearchTool(tool) && !tool.bypassMultiToolsLimit) {
      return buildSearchToolError(agent.name, 'VertexAiSearchTool');
    }
    if (isEnterpriseWebSearchTool(tool)) {
      return (
        `Agent '${agent.name}' has sub-agent transfer targets but is ` +
        'configured with EnterpriseWebSearchTool. Gemini API does not allow ' +
        'EnterpriseWebSearchTool to be combined with function calling (agent ' +
        'delegation).'
      );
    }
  }
  return undefined;
}

/**
 * Augments the {@link LlmRequest} to support agent transfer. When the current
 * agent has reachable transfer targets (sub-agents, peer agents, or a parent
 * agent), this processor registers a `transfer_to_agent` function tool and
 * appends instructions describing each candidate so the model can choose to
 * hand off control.
 */
export class AgentTransferLlmRequestProcessor extends BaseLlmRequestProcessor {
  private readonly tool = new FunctionTool({
    name: TRANSFER_TO_AGENT_TOOL_NAME,
    description:
      'Transfer the question to another agent. This tool hands off control to another agent when it is more suitable to answer the user question according to the agent description.',
    parameters: z.object({
      agentName: z.string().describe('the agent name to transfer to.'),
    }),
    execute: function (args: {agentName: string}, toolContext?: Context) {
      if (!toolContext) {
        throw new Error('toolContext is required.');
      }
      toolContext.actions.transferToAgent = args.agentName;
      return 'Transfer queued';
    },
  });

  /**
   * Appends transfer instructions and registers the `transfer_to_agent` tool
   * when the agent has reachable transfer targets.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request to augment with transfer instructions and the transfer tool.
   * @throws If the agent can transfer to a sub-agent while it carries a
   *     built-in search tool that the Gemini API refuses to combine with
   *     function calling.
   */
  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }

    const transferTargets = getTransferTargets(agent);
    if (!transferTargets.length) {
      return;
    }

    const errorMessage = getIncompatibleBuiltInToolError(agent);
    if (errorMessage) {
      if (agent.subAgents.some(isTransferTarget)) {
        throw new Error(errorMessage);
      }
      return;
    }

    // A task or single_turn agent gets no instructions: the graph, not the
    // model, decides where it hands control next. It still gets the tool.
    if (!NON_TRANSFERABLE_MODES.includes(agent.mode)) {
      appendInstructions(llmRequest, [
        buildTransferInstructions(agent, transferTargets),
      ]);
    }

    const toolContext = new Context({invocationContext});
    await this.tool.processLlmRequest({toolContext, llmRequest});
  }
}

export const AGENT_TRANSFER_LLM_REQUEST_PROCESSOR =
  new AgentTransferLlmRequestProcessor();
