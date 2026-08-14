/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Part} from '@google/genai';
import {createUserContent} from '@google/genai';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {RequestHandlerExtra} from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ContentBlock,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';

import type {BaseAgent} from '../../agents/base_agent.js';
import {isFinalResponse} from '../../events/event.js';
import {InMemoryRunner} from '../../runner/in_memory_runner.js';
import type {Runner} from '../../runner/runner.js';
import {version} from '../../version.js';

/** The synthetic ADK user id used for every MCP-driven conversation. */
const MCP_USER_ID = 'mcp_user';

/** The URI carried by inline data that is neither an image nor audio. */
const INLINE_RESOURCE_URI = 'resource://adk-agent/inline-data';

/** The default MIME type for inline data that does not declare one. */
const DEFAULT_MIME_TYPE = 'application/octet-stream';

/** The context object the MCP SDK passes to a tool callback. */
type ToolCallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Options for {@link toMcpServer}. */
export interface ToMcpServerOptions {
  /** The MCP server and tool name. Defaults to the agent's name. */
  name?: string;
  /** Optional instructions the MCP host may show to its model. */
  instructions?: string;
  /** A pre-built Runner. If omitted, one is built with in-memory services. */
  runner?: Runner;
}

/**
 * Maps one ADK content part to an MCP content block.
 *
 * @param part An ADK content part from the agent's response.
 * @returns The matching MCP content block (text, image, audio, or embedded
 *   resource), or `undefined` for a part with no renderable content (e.g. a
 *   function call).
 */
export function partToContent(part: Part): ContentBlock | undefined {
  if (part.text) {
    return {type: 'text', text: part.text};
  }
  const blob = part.inlineData;
  if (blob?.data === undefined) {
    return undefined;
  }
  // `@google/genai` already types `Blob.data` as a base64 string, so it is
  // forwarded verbatim; re-encoding it would double-base64 every payload.
  const data = blob.data;
  const mimeType = blob.mimeType || DEFAULT_MIME_TYPE;
  switch (mimeType.split('/')[0]) {
    case 'image':
      return {type: 'image', data, mimeType};
    case 'audio':
      return {type: 'audio', data, mimeType};
    default:
      return {
        type: 'resource',
        resource: {uri: INLINE_RESOURCE_URI, blob: data, mimeType},
      };
  }
}

/**
 * Forwards an intermediate agent message to the MCP host as progress.
 *
 * Progress is best effort: a host that did not supply a progress token did not
 * ask for progress, and notifying it anyway would violate the MCP protocol.
 */
async function reportProgress(
  extra: ToolCallExtra,
  message: string,
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (!message || progressToken === undefined) {
    return;
  }
  await extra.sendNotification({
    method: 'notifications/progress',
    params: {progressToken, progress: 0, message},
  });
}

/**
 * Runs the agent for one request and returns its final response content.
 *
 * Intermediate (non-final) text events are forwarded as MCP progress
 * notifications when `extra` is supplied.
 *
 * @param runner The Runner that executes the agent.
 * @param request The user request text for this call.
 * @param sessionId The ADK session this call belongs to.
 * @param extra The MCP tool call context, used to report progress.
 * @returns The agent's final response as a list of MCP content blocks (text
 *   plus any images, audio, or other data the agent produced).
 */
export async function runAgent(
  runner: Runner,
  request: string,
  sessionId: string,
  extra?: ToolCallExtra,
): Promise<ContentBlock[]> {
  const finalContent: ContentBlock[] = [];
  for await (const event of runner.runAsync({
    userId: MCP_USER_ID,
    sessionId,
    newMessage: createUserContent(request),
  })) {
    const parts = event.content?.parts;
    if (!parts?.length) {
      continue;
    }
    if (isFinalResponse(event)) {
      for (const part of parts) {
        const block = partToContent(part);
        if (block !== undefined) {
          finalContent.push(block);
        }
      }
    } else if (extra !== undefined) {
      await reportProgress(
        extra,
        parts.map((part) => part.text ?? '').join(''),
      );
    }
  }
  return finalContent;
}

/**
 * Exposes an ADK agent as an MCP server.
 *
 * The returned server registers a single MCP tool that runs the agent: an MCP
 * host (e.g. Claude Code, OpenAI Codex, an IDE, or any MCP client) sends a
 * request string and receives the agent's final response, including any images
 * or audio the agent produced. This is the MCP counterpart of `toA2a`; it lets
 * harnesses that speak MCP drive an ADK agent.
 *
 * All tool calls on the returned server share one ADK session, so successive
 * calls form a single multi-turn conversation. An `McpServer` owns exactly one
 * transport, so a host that serves several clients — for example over
 * streamable HTTP — should build one server per client session.
 *
 * The server is returned unconnected and binds nothing: the caller chooses the
 * transport, and therefore owns any network exposure and its authentication.
 *
 * @param agent The ADK agent to serve.
 * @param options Configuration options.
 * @returns An `McpServer` exposing the agent as a single tool, ready for
 *   `server.connect(transport)`.
 * @experimental (Experimental, subject to change)
 *
 * @example
 * ```typescript
 * const agent = new LlmAgent({name: 'assistant', model: 'gemini-2.0-flash'});
 * const server = toMcpServer(agent);
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function toMcpServer(
  agent: BaseAgent,
  options: ToMcpServerOptions = {},
): McpServer {
  const toolName = options.name ?? agent.name;
  const server = new McpServer(
    {name: toolName, version},
    {instructions: options.instructions},
  );
  const agentRunner =
    options.runner ?? new InMemoryRunner({agent, appName: agent.name});
  let sessionIdPromise: Promise<string> | undefined;

  server.registerTool(
    toolName,
    {
      description: agent.description || `Run the ${toolName} agent.`,
      inputSchema: {request: z.string().describe('The request for the agent.')},
    },
    async ({request}, extra) => {
      // A failed creation must not stay memoised, or one transient session
      // store error would brick every later call on this server.
      sessionIdPromise ??= agentRunner.sessionService
        .createSession({appName: agentRunner.appName, userId: MCP_USER_ID})
        .then((session) => session.id)
        .catch((error: unknown) => {
          sessionIdPromise = undefined;
          throw error;
        });
      const sessionId = await sessionIdPromise;
      return {content: await runAgent(agentRunner, request, sessionId, extra)};
    },
  );
  return server;
}
