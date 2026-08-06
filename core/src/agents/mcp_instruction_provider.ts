/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MCPConnectionParams,
  MCPSessionManager,
} from '../tools/mcp/mcp_session_manager.js';

import {InstructionProvider} from './llm_agent.js';
import {ReadonlyContext} from './readonly_context.js';

/**
 * Builds an {@link InstructionProvider} that fetches an agent's instruction
 * from a named prompt on an MCP server, so instructions can be centrally
 * managed on that server.
 *
 * On each invocation the returned provider connects to the MCP server, resolves
 * the prompt named `promptName`, fills the prompt's declared arguments from
 * session state, and returns the concatenated text of the prompt's messages.
 *
 * @example
 * const agent = new LlmAgent({
 *   model: 'gemini-2.0-flash',
 *   name: 'agent',
 *   instruction: mcpInstructionProvider(connectionParams, 'my_prompt'),
 * });
 *
 * @param connectionParams Parameters for connecting to the MCP server.
 * @param promptName The name of the MCP prompt to fetch.
 * @returns An {@link InstructionProvider} resolving to the instruction text.
 */
export function mcpInstructionProvider(
  connectionParams: MCPConnectionParams,
  promptName: string,
): InstructionProvider {
  const sessionManager = new MCPSessionManager(connectionParams);
  return async (context: ReadonlyContext): Promise<string> => {
    const session = await sessionManager.createSession();
    try {
      const {prompts} = await session.listPrompts();
      const promptDefinition = prompts.find((p) => p.name === promptName);

      // Forward only the prompt's declared arguments that are present in state.
      const state = context.state;
      const promptArgs: Record<string, string> = {};
      for (const {name} of promptDefinition?.arguments ?? []) {
        if (state.has(name)) {
          promptArgs[name] = String(state.get(name));
        }
      }

      const promptResult = await session.getPrompt({
        name: promptName,
        arguments: promptArgs,
      });

      if (promptResult.messages.length === 0) {
        throw new Error(`Failed to load MCP prompt '${promptName}'.`);
      }

      return promptResult.messages
        .map((message) =>
          message.content.type === 'text' ? message.content.text : '',
        )
        .join('');
    } finally {
      await sessionManager.closeSession(session);
    }
  };
}
