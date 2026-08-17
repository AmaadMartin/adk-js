/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {z} from 'zod';
import {FunctionTool} from './function_tool.js';

/** The name the model calls to hand off control to another agent. */
export const TRANSFER_TO_AGENT_TOOL_NAME = 'transfer_to_agent';

const TRANSFER_TO_AGENT_TOOL_DESCRIPTION =
  'Transfer the question to another agent. This tool hands off control to another agent when it is more suitable to answer the user question according to the agent description.';

const transferToAgentParameters = z.object({
  agentName: z.string().describe('the agent name to transfer to.'),
});

/**
 * The synthetic tool that hands off control to another agent.
 *
 * Its declaration constrains `agentName` to the target names given to the
 * constructor, so a model that respects the schema cannot name an agent that
 * is absent from the agent tree.
 */
export class TransferToAgentTool extends FunctionTool<
  typeof transferToAgentParameters
> {
  private readonly agentNames: readonly string[];

  /**
   * @param agentNames - The valid transfer target names.
   */
  constructor(agentNames: readonly string[]) {
    super({
      name: TRANSFER_TO_AGENT_TOOL_NAME,
      description: TRANSFER_TO_AGENT_TOOL_DESCRIPTION,
      parameters: transferToAgentParameters,
      execute: (args, toolContext) => {
        if (!toolContext) {
          throw new Error('toolContext is required.');
        }
        toolContext.actions.transferToAgent = args.agentName;
        return 'Transfer queued';
      },
    });
    this.agentNames = agentNames;
  }

  /**
   * Returns the declaration of the base function tool with the valid target
   * names attached to `agentName` as a JSON-Schema enum.
   */
  override _getDeclaration(): FunctionDeclaration {
    const declaration = super._getDeclaration();
    const agentNameSchema = declaration.parameters?.properties?.['agentName'];
    if (agentNameSchema) {
      agentNameSchema.enum = [...this.agentNames];
    }
    return declaration;
  }
}
