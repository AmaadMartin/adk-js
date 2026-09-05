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

/** The options {@link RemoteMcpServer} is constructed from. */
export interface RemoteMcpServerOptions {
  /**
   * Full URL of the remote MCP server endpoint, for example
   * `https://api.example.com/mcp`.
   */
  url: string;

  /** Optional server label. */
  name?: string;

  /**
   * Static headers sent on every turn, for example a fixed API key. Merged
   * with {@link RemoteMcpServerOptions.headerProvider} output, which wins on a
   * key conflict.
   */
  headers?: Record<string, string>;

  /** Restricts which of the server's tools the model may call. */
  allowedTools?: string[];

  /** Runtime callback that mints headers at request time, once per turn. */
  headerProvider?: RemoteMcpHeaderProvider;
}

const remoteMcpServerSchema = z.strictObject({
  url: z.string(),
  name: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  // Zod has no schema for a function type, so the callback is checked by hand.
  headerProvider: z
    .custom<RemoteMcpHeaderProvider>((value) => typeof value === 'function')
    .optional(),
});

/**
 * Describes why a construction failed, naming the offending keys. Values are
 * deliberately left out: a header value is a credential.
 */
function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) =>
      issue.code === 'unrecognized_keys'
        ? `unknown key(s) ${issue.keys.join(', ')}`
        : `invalid value for '${issue.path.join('.')}'`,
    )
    .join('; ');
}

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
export class RemoteMcpServer {
  /** Full URL of the remote MCP server endpoint. */
  url: string;

  /** Optional server label. */
  name?: string;

  /** Static headers sent on every turn. */
  headers?: Record<string, string>;

  /** Restricts which of the server's tools the model may call. */
  allowedTools?: string[];

  /** Runtime callback that mints headers at request time. */
  headerProvider?: RemoteMcpHeaderProvider;

  /**
   * @param options The server description.
   * @throws {InputValidationError} If `options` carries an unknown key, or a
   *   known key of the wrong type.
   */
  constructor(options: RemoteMcpServerOptions) {
    // TypeScript rejects a stray key in an object literal already. This check
    // catches the widened-object and plain-JavaScript callers it cannot see.
    const parsed = remoteMcpServerSchema.safeParse(options);
    if (!parsed.success) {
      throw new InputValidationError(
        `Invalid RemoteMcpServer: ${describeIssues(parsed.error.issues)}.`,
      );
    }
    this.url = options.url;
    this.name = options.name;
    this.headers = options.headers;
    this.allowedTools = options.allowedTools;
    this.headerProvider = options.headerProvider;
  }
}
