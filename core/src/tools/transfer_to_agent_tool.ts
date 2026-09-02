/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {z} from 'zod';

import {Context} from '../agents/context.js';
import {TRANSFER_TO_AGENT_FUNCTION_CALL_NAME} from '../agents/framework_function_calls.js';
import {FunctionTool} from './function_tool.js';

/**
 * The name the model calls to hand off control to another agent.
 *
 * This tool registers itself under the name, and the content processor
 * recognises the resulting call by it. Both read the name from
 * `framework_function_calls`, so a rename cannot break the pairing silently.
 */
export const TRANSFER_TO_AGENT_TOOL_NAME = TRANSFER_TO_AGENT_FUNCTION_CALL_NAME;

/** The model-facing parameter that carries the target agent. */
const AGENT_NAME_PARAMETER = 'agentName';

const TRANSFER_TO_AGENT_DESCRIPTION =
  'Transfer the question to another agent. This tool hands off control to another agent when it is more suitable to answer the user question according to the agent description.';

const TRANSFER_TO_AGENT_PARAMETERS = z.object({
  agentName: z.string().describe('the agent name to transfer to.'),
});

/** The result the tool reports once it has queued the hand-off. */
const TRANSFER_QUEUED = 'Transfer queued';

/** Configuration for {@link TransferToAgentTool}. */
export interface TransferToAgentToolConfig {
  /** The agent names the model may transfer to. */
  agentNames: string[];
}

/** Narrows a value to an indexable record, or `undefined` when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Returns the `agentName` entry of a JSON-Schema parameter description.
 *
 * `@google/genai` types `FunctionDeclaration.parametersJsonSchema` as
 * `unknown`, so the shape is checked at run time.
 */
function getJsonSchemaAgentName(
  parametersJsonSchema: unknown,
): Record<string, unknown> | undefined {
  const properties = asRecord(asRecord(parametersJsonSchema)?.['properties']);
  return asRecord(properties?.[AGENT_NAME_PARAMETER]);
}

/**
 * Hands off control to another agent.
 *
 * Prefer {@link TransferToAgentTool} over this function: the tool also tells
 * the model which agent names are valid.
 *
 * @param input - The name of the agent to transfer to.
 * @param toolContext - The context of the call, which records the hand-off.
 * @returns The confirmation that the hand-off is queued.
 */
export function transferToAgent(
  input: {agentName: string},
  toolContext?: Context,
): string {
  if (!toolContext) {
    throw new Error('toolContext is required.');
  }
  toolContext.actions.transferToAgent = input.agentName;
  return TRANSFER_QUEUED;
}

/**
 * The tool that hands off control to another agent.
 *
 * Its declaration restricts `agentName` to the names given to the constructor,
 * so a model that follows the schema cannot name an agent that does not exist.
 * The restriction is a hint to the model, not a run-time check: an unknown name
 * still reaches {@link transferToAgent} and fails later in the hand-off.
 */
export class TransferToAgentTool extends FunctionTool<
  typeof TRANSFER_TO_AGENT_PARAMETERS
> {
  private readonly agentNames: readonly string[];

  constructor(config: TransferToAgentToolConfig) {
    super({
      name: TRANSFER_TO_AGENT_TOOL_NAME,
      description: TRANSFER_TO_AGENT_DESCRIPTION,
      parameters: TRANSFER_TO_AGENT_PARAMETERS,
      execute: transferToAgent,
    });
    this.agentNames = [...config.agentNames];
  }

  /**
   * Returns the base declaration with the valid target names attached to
   * `agentName` as a JSON-Schema enum.
   */
  override _getDeclaration(): FunctionDeclaration {
    const declaration = super._getDeclaration();

    const agentNameSchema =
      declaration.parameters?.properties?.[AGENT_NAME_PARAMETER];
    if (agentNameSchema) {
      agentNameSchema.enum = [...this.agentNames];
    }

    const jsonSchemaAgentName = getJsonSchemaAgentName(
      declaration.parametersJsonSchema,
    );
    if (jsonSchemaAgentName) {
      jsonSchemaAgentName['enum'] = [...this.agentNames];
    }

    return declaration;
  }
}
