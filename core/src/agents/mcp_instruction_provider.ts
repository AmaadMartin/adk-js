/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {State} from '../sessions/state.js';
import {
  MCPConnectionParams,
  MCPSessionManager,
} from '../tools/mcp/mcp_session_manager.js';

import {InstructionProvider} from './llm_agent.js';
import {ReadonlyContext} from './readonly_context.js';

/**
 * Reads the values a prompt declares as its arguments out of session state.
 *
 * MCP types a prompt argument as a string on the wire, so a value that is not
 * already a string is serialized rather than coerced: `String({a: 1})` yields
 * `'[object Object]'` and loses the data.
 *
 * @param declaredArgs The arguments the prompt definition declares.
 * @param state The session state to read the values from.
 * @returns The declared arguments that state holds, keyed by argument name.
 */
function promptArgsFromState(
  declaredArgs: ReadonlyArray<{name: string}>,
  state: Readonly<State>,
): Record<string, string> {
  const promptArgs: Record<string, string> = {};
  for (const {name} of declaredArgs) {
    const value = state.get(name);
    if (value === undefined) {
      continue;
    }
    promptArgs[name] =
      typeof value === 'string' ? value : JSON.stringify(value);
  }
  return promptArgs;
}

/**
 * Builds an {@link InstructionProvider} that reads an agent's instruction from
 * a named prompt on an MCP server, so a prompt can be managed on that server
 * instead of being hardcoded in the agent.
 *
 * On every invocation the provider opens a session, looks the prompt up in
 * `listPrompts()`, fills the arguments the prompt declares from session state,
 * and returns the concatenated text of the prompt's text messages. State keys
 * the prompt does not declare are never sent. A prompt the server does not
 * advertise is still fetched, with no arguments.
 *
 * @example
 * const agent = new LlmAgent({
 *   name: 'support_agent',
 *   model: 'gemini-2.5-flash',
 *   instruction: mcpInstructionProvider(
 *     {type: 'StreamableHTTPConnectionParams', url: 'https://host/mcp'},
 *     'support_system_prompt',
 *   ),
 * });
 *
 * @param connectionParams How to connect to the MCP server.
 * @param promptName The name of the MCP prompt to fetch.
 * @returns An {@link InstructionProvider} resolving to the instruction text.
 * @throws Error When the prompt result carries no messages.
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

      const promptResult = await session.getPrompt({
        name: promptName,
        arguments: promptArgsFromState(
          promptDefinition?.arguments ?? [],
          context.state,
        ),
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
