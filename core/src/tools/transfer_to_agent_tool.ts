/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {z} from 'zod';

import {Context} from '../agents/context.js';
import {FunctionTool} from './function_tool.js';

/** The name the model calls to hand off control to another agent. */
export const TRANSFER_TO_AGENT_TOOL_NAME = 'transfer_to_agent';

/** The model-facing parameter that carries the target agent. */
const AGENT_NAME_PARAMETER = 'agentName';

/** The model-facing parameter that carries the reason for the hand-off. */
const TRANSFER_REASON_PARAMETER = 'transferReason';

const TRANSFER_TO_AGENT_DESCRIPTION =
  'Transfer the question to another agent. This tool hands off control to another agent when it is more suitable to answer the user question according to the agent description.';

const TRANSFER_TO_AGENT_DESCRIPTION_WITH_REASON =
  `${TRANSFER_TO_AGENT_DESCRIPTION} Set ${TRANSFER_REASON_PARAMETER} to the ` +
  'reason for transferring to the target agent.';

const TRANSFER_TO_AGENT_PARAMETERS = z.object({
  agentName: z.string().describe('the agent name to transfer to.'),
  transferReason: z
    .string()
    .optional()
    .describe('the reason for transferring to the target agent.'),
});

/** Configuration for {@link TransferToAgentTool}. */
export interface TransferToAgentToolConfig {
  /** The agent names the model may transfer to. */
  agentNames: string[];
  /**
   * Whether the model is asked why it transfers. When false the tool neither
   * declares the reason parameter nor mentions it to the model. Defaults to
   * false.
   */
  includeTransferReason?: boolean;
}

/**
 * Hands off control to another agent.
 *
 * Prefer {@link TransferToAgentTool} over this function: the tool also tells
 * the model which agent names are valid.
 *
 * @param input - The name of the agent to transfer to, and why.
 * @param toolContext - The context of the call, which records the hand-off.
 * @returns The confirmation that the hand-off is queued.
 */
export function transferToAgent(
  input: {agentName: string; transferReason?: string},
  toolContext?: Context,
): string {
  if (!toolContext) {
    throw new Error('toolContext is required.');
  }
  toolContext.actions.transferToAgent = input.agentName;
  // An empty reason counts as no reason, matching Python's
  // `transfer_reason or None`.
  toolContext.actions.transferReason = input.transferReason || undefined;
  return 'Transfer queued';
}

/**
 * The tool that hands off control to another agent.
 *
 * Its declaration restricts `agentName` to the names given to the constructor,
 * so a model that follows the schema cannot name an agent that does not exist.
 * The restriction is a hint to the model, not a run-time check: an unknown name
 * still reaches {@link transferToAgent} and fails later in the hand-off.
 *
 * The model is asked why it transfers only when
 * {@link TransferToAgentToolConfig.includeTransferReason} is set. The function
 * accepts a reason either way; the option decides what the declaration offers.
 */
export class TransferToAgentTool extends FunctionTool<
  typeof TRANSFER_TO_AGENT_PARAMETERS
> {
  private readonly agentNames: readonly string[];
  private readonly includeTransferReason: boolean;

  constructor(config: TransferToAgentToolConfig) {
    super({
      name: TRANSFER_TO_AGENT_TOOL_NAME,
      description: config.includeTransferReason
        ? TRANSFER_TO_AGENT_DESCRIPTION_WITH_REASON
        : TRANSFER_TO_AGENT_DESCRIPTION,
      parameters: TRANSFER_TO_AGENT_PARAMETERS,
      execute: transferToAgent,
    });
    this.agentNames = [...config.agentNames];
    this.includeTransferReason = config.includeTransferReason ?? false;
  }

  /**
   * Returns the base declaration with the valid target names attached to
   * `agentName` as a JSON-Schema enum, and with `transferReason` removed
   * unless the tool asks for a reason.
   */
  override _getDeclaration(): FunctionDeclaration {
    const declaration = super._getDeclaration();

    const properties = declaration.parameters?.properties;
    if (!properties) {
      return declaration;
    }

    const agentNameSchema = properties[AGENT_NAME_PARAMETER];
    if (agentNameSchema) {
      agentNameSchema.enum = [...this.agentNames];
    }
    if (!this.includeTransferReason) {
      delete properties[TRANSFER_REASON_PARAMETER];
    }

    return declaration;
  }
}
