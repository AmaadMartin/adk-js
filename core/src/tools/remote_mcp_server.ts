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
 *
 * Named for the remote server because `tools/mcp/mcp_auth.ts` already exports
 * `McpHeaderProvider` for the client-side session.
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
 * connects to the server described here. The two share only the
 * header-provider contract.
 *
 * Mirrors `RemoteMcpServer` in google/adk-python `tools/_remote_mcp_server.py`,
 * which models it as a validated pydantic model. TypeScript rejects an unknown
 * property on an object literal at compile time, which covers the same mistake
 * for a literal. A description TypeScript never saw goes through
 * {@link createRemoteMcpServer}, which applies the same rules at run time.
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

  /** Restricts which of the server's tools the backend may call. */
  allowedTools?: string[];

  /** Runtime callback that mints headers at request time, once per turn. */
  headerProvider?: RemoteMcpHeaderProvider;
}

/**
 * Whether `value` is a {@link RemoteMcpServer} spec.
 *
 * A spec is a plain object carrying a string `url`. Test a `BaseTool` first:
 * a future tool could also expose a `url`, and a tool must never be read as a
 * server spec. A caller that must reject a malformed spec, rather than only
 * recognize a good one, calls {@link createRemoteMcpServer} instead.
 *
 * @param value The value to test.
 * @return True when `value` has the shape of a server spec.
 */
export function isRemoteMcpServer(value: unknown): value is RemoteMcpServer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'url' in value &&
    typeof value.url === 'string'
  );
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
 * Merges the static headers of a remote MCP server with the output of its
 * header provider, for one turn.
 *
 * The static headers are copied first, then the provider output is assigned
 * over the copy, so the provider wins on a key conflict. The copy keeps the
 * spec's own `headers` object unchanged. An error from the provider
 * propagates: a failed token mint must be loud, not a silently missing header.
 *
 * A caller that wants the tool param, not the headers, calls
 * `resolveMcpServerParam` in `models/interactions_utils.ts` instead.
 *
 * @param server The server spec.
 * @param context The context of the turn the headers are minted for.
 * @return The headers to send. Empty when the server declares none.
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
