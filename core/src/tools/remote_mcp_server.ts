/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import type {ReadonlyContext} from '../agents/readonly_context.js';
import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * Mints headers for one remote MCP turn, from the invocation that asked for
 * it. Use it to carry a token that must be fresh on every turn.
 */
export type RemoteMcpHeaderProvider = (
  context: ReadonlyContext,
) => Record<string, string> | Promise<Record<string, string>>;

/**
 * A remote MCP server that the Managed Agents API runs server-side.
 *
 * The caller describes the endpoint; ADK forwards its URL and headers to the
 * Interactions API, and the backend opens the Model Context Protocol session
 * and runs the tools. Only remote (HTTP or streamable) MCP servers work here.
 *
 * This is server-side MCP. `McpToolset` is the client-side counterpart: it
 * opens the session itself and runs the tools in this process. ADK never
 * connects to the server described here.
 */
export interface RemoteMcpServer {
  /**
   * Full URL of the remote MCP server endpoint, for example
   * `https://api.example.com/mcp`.
   */
  url: string;

  /** Optional server label. */
  name?: string;

  /**
   * Static headers sent on every turn, for example a fixed API key. Merged
   * with {@link RemoteMcpServer.headerProvider} output, which wins on a key
   * conflict.
   */
  headers?: Record<string, string>;

  /** Restricts which of the server's tools the model may call. */
  allowedTools?: string[];

  /** Runtime callback that mints headers at request time, once per turn. */
  headerProvider?: RemoteMcpHeaderProvider;
}

const remoteMcpServerSchema = z.strictObject({
  url: z
    .string({error: 'must be a string.'})
    .min(1, {error: 'must not be empty.'}),
  name: z.string({error: 'must be a string.'}).optional(),
  headers: z
    .record(z.string(), z.string({error: 'must be a string.'}), {
      error: 'must be a record of strings.',
    })
    .optional(),
  allowedTools: z
    .array(z.string({error: 'must be a string.'}), {
      error: 'must be an array of strings.',
    })
    .optional(),
  headerProvider: z
    .custom<RemoteMcpHeaderProvider>((value) => typeof value === 'function', {
      error: 'must be a function.',
    })
    .optional(),
});

/**
 * Validates a remote MCP server description and returns it as a
 * {@link RemoteMcpServer}.
 *
 * TypeScript rejects an unknown key only on a fresh object literal, so a
 * widened object and a plain-JavaScript caller both reach this function
 * unchecked. It rejects an unknown key and a field of the wrong type, matching
 * the reference model's `extra='forbid'`. It returns a new object, so a later
 * edit to the argument cannot change the validated specification.
 *
 * @param spec The description to validate.
 * @return The validated specification.
 * @throws InputValidationError If a key is unknown, `url` is missing or empty,
 *     or a field has the wrong type.
 */
export function createRemoteMcpServer(spec: unknown): RemoteMcpServer {
  const result = remoteMcpServerSchema.safeParse(spec);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new InputValidationError(
    issue.code === 'unrecognized_keys'
      ? `RemoteMcpServer does not accept the fields: ${issue.keys.join(', ')}.`
      : `RemoteMcpServer.${issue.path.join('.')} ${issue.message}`,
  );
}

/**
 * Merges the static headers of a {@link RemoteMcpServer} with the output of
 * its `headerProvider`, for one turn.
 *
 * The static headers are copied first, then the provider output is assigned
 * over the copy, so the provider wins on a key conflict. The copy means the
 * specification's own `headers` object is never changed. An error from the
 * provider propagates: a failed token mint must be loud, not a silently
 * missing header.
 *
 * @param server The server description.
 * @param context The context of the turn the headers are minted for.
 * @return The headers to send, empty when the server declares none.
 */
export async function resolveRemoteMcpServerHeaders(
  server: RemoteMcpServer,
  context: ReadonlyContext,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {...server.headers};
  if (server.headerProvider !== undefined) {
    Object.assign(headers, await server.headerProvider(context));
  }
  return headers;
}
