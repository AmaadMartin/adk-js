/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionDeclaration} from '@google/genai';
import {z} from 'zod';

import type {Context} from '../agents/context.js';
import {FunctionTool} from './function_tool.js';

/** The name the model calls to hand off control to another agent. */
export const TRANSFER_TO_AGENT_TOOL_NAME = 'transfer_to_agent';

/**
 * The model-facing parameter that carries the target agent.
 *
 * It is `agent_name`, not `agentName`. The name is wire format: it appears in
 * the declaration sent to the model and in the events that get persisted, and
 * `google/adk-python` spells it `agent_name`, so a transcript written by one
 * runtime stays readable by the other.
 */
const AGENT_NAME_PARAMETER = 'agent_name';

const AGENT_NAME_DESCRIPTION = 'the agent name to transfer to.';

const TRANSFER_TO_AGENT_DESCRIPTION =
  'Transfer the question to another agent. This tool hands off control to another agent when it is more suitable to answer the user question according to the agent description.';

/**
 * Builds the parameter schema for a tool restricted to `agentNames`.
 *
 * The names become a zod enum, so an unreachable target fails argument
 * validation rather than reaching {@link transferToAgent}. An empty list
 * constrains nothing: the tool still declares the parameter, and the enum in
 * the declaration is empty.
 *
 * @param agentNames - The agent names the model may transfer to.
 * @returns The schema the tool validates its arguments against.
 */
function transferToAgentParameters(agentNames: readonly string[]) {
  const agentName =
    agentNames.length > 0
      ? z.enum([...agentNames] as [string, ...string[]])
      : z.string();
  return z.object({
    [AGENT_NAME_PARAMETER]: agentName.describe(AGENT_NAME_DESCRIPTION),
  });
}

/** The parameter schema of {@link TransferToAgentTool}. */
type TransferToAgentParameters = ReturnType<typeof transferToAgentParameters>;

/** Configuration for {@link TransferToAgentTool}. */
export interface TransferToAgentToolConfig {
  /** The agent names the model may transfer to. */
  agentNames: string[];
}

/**
 * Hands off control to another agent.
 *
 * Prefer {@link TransferToAgentTool} over this function: the tool also tells
 * the model which agent names are valid, and rejects the ones that are not.
 *
 * @param input - The name of the agent to transfer to.
 * @param toolContext - The context of the call, which records the hand-off.
 * @returns The confirmation that the hand-off is queued.
 */
export function transferToAgent(
  input: {agent_name: string},
  toolContext?: Context,
): string {
  if (!toolContext) {
    throw new Error('toolContext is required.');
  }
  toolContext.actions.transferToAgent = input.agent_name;
  return 'Transfer queued';
}

/**
 * The tool that hands off control to another agent.
 *
 * Its declaration restricts `agent_name` to the names given to the
 * constructor, so a model that follows the schema cannot name an agent that
 * does not exist. The names are also enforced: a hallucinated target fails
 * argument validation and comes back to the model as a tool error it can
 * retry, instead of queueing a hand-off to an agent that is not there.
 */
export class TransferToAgentTool extends FunctionTool<TransferToAgentParameters> {
  private readonly agentNames: readonly string[];

  constructor(config: TransferToAgentToolConfig) {
    super({
      name: TRANSFER_TO_AGENT_TOOL_NAME,
      description: TRANSFER_TO_AGENT_DESCRIPTION,
      parameters: transferToAgentParameters(config.agentNames),
      execute: transferToAgent,
    });
    this.agentNames = [...config.agentNames];
  }

  /**
   * Returns the base declaration with the valid target names attached to
   * `agent_name` as a JSON-Schema enum.
   */
  override _getDeclaration(): FunctionDeclaration {
    const declaration = super._getDeclaration();

    const agentNameSchema =
      declaration.parameters?.properties?.[AGENT_NAME_PARAMETER];
    if (agentNameSchema) {
      agentNameSchema.enum = [...this.agentNames];
    }

    return declaration;
  }
}
