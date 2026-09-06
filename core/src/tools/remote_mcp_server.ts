/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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

/**
 * The unvalidated form of a {@link RemoteMcpServer}.
 *
 * The field names are checked when you compile, the field values when
 * {@link createRemoteMcpServer} runs. A plain-JavaScript caller and a
 * configuration file both reach the factory with values TypeScript never saw.
 */
export type RemoteMcpServerInput = {
  [K in keyof RemoteMcpServer]?: unknown;
};

/**
 * The fields {@link createRemoteMcpServer} accepts.
 *
 * Keyed by `keyof RemoteMcpServer` so that a field added to the interface
 * fails to compile until it is listed here.
 */
const REMOTE_MCP_SERVER_KEYS: Record<keyof RemoteMcpServer, true> = {
  url: true,
  name: true,
  headers: true,
  allowedTools: true,
  headerProvider: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHeaderProvider(value: unknown): value is RemoteMcpHeaderProvider {
  return typeof value === 'function';
}

function rejectUnknownKeys(spec: RemoteMcpServerInput): void {
  const unknownKeys = Object.keys(spec).filter(
    (key) => !Object.hasOwn(REMOTE_MCP_SERVER_KEYS, key),
  );
  if (unknownKeys.length > 0) {
    throw new InputValidationError(
      `RemoteMcpServer does not accept the fields: ${unknownKeys.join(', ')}.`,
    );
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InputValidationError(
      `RemoteMcpServer.${field} must be a string.`,
    );
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (text === '') {
    throw new InputValidationError(
      `RemoteMcpServer.${field} must not be empty.`,
    );
  }
  return text;
}

function requireStringRecord(
  value: unknown,
  field: string,
): Record<string, string> {
  if (!isRecord(value)) {
    throw new InputValidationError(
      `RemoteMcpServer.${field} must be a record of strings.`,
    );
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = requireString(entry, `${field}.${key}`);
  }
  return record;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new InputValidationError(
      `RemoteMcpServer.${field} must be an array of strings.`,
    );
  }
  return value.map((item: unknown, index: number) =>
    requireString(item, `${field}[${index}]`),
  );
}

function requireHeaderProvider(
  value: unknown,
  field: string,
): RemoteMcpHeaderProvider {
  if (!isHeaderProvider(value)) {
    throw new InputValidationError(
      `RemoteMcpServer.${field} must be a function.`,
    );
  }
  return value;
}

/**
 * Validates a remote MCP server description and returns it as a
 * {@link RemoteMcpServer}.
 *
 * TypeScript rejects an unknown key only on a fresh object literal, so a
 * widened object and a plain-JavaScript caller both reach the constructor
 * unchecked. This factory closes that hole: it rejects an unknown key and a
 * field of the wrong type, matching the reference model's `extra='forbid'`.
 * It returns a new object, so a later edit to the argument cannot change the
 * validated specification.
 *
 * @param spec The description to validate.
 * @return The validated specification.
 * @throws InputValidationError If a key is unknown, `url` is missing or empty,
 *     or a field has the wrong type.
 */
export function createRemoteMcpServer(
  spec: RemoteMcpServerInput,
): RemoteMcpServer {
  rejectUnknownKeys(spec);
  const server: RemoteMcpServer = {
    url: requireNonEmptyString(spec.url, 'url'),
  };
  if (spec.name !== undefined) {
    server.name = requireString(spec.name, 'name');
  }
  if (spec.headers !== undefined) {
    server.headers = requireStringRecord(spec.headers, 'headers');
  }
  if (spec.allowedTools !== undefined) {
    server.allowedTools = requireStringArray(spec.allowedTools, 'allowedTools');
  }
  if (spec.headerProvider !== undefined) {
    server.headerProvider = requireHeaderProvider(
      spec.headerProvider,
      'headerProvider',
    );
  }
  return server;
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
