/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Database} from '@google-cloud/spanner';
import {z} from 'zod';
import {FunctionTool, ToolExecuteArgument} from '../function_tool.js';
import {
  SpannerDatabaseDialect,
  SpannerDatabaseTarget,
  withSpannerDatabase,
} from './client.js';
import {SpannerCredentialsManager} from './spanner_credentials.js';
import {runSpannerTool, SpannerToolResult} from './tool_result.js';

/** Prefix prepended to every tool name in the Spanner toolsets. */
export const SPANNER_TOOL_NAME_PREFIX = 'spanner';

/** The dialect name the tools that only speak GoogleSQL refuse. */
export const POSTGRESQL_DIALECT = 'POSTGRESQL';

/** What a tool reports when it cannot run against a PostgreSQL database. */
export const UNSUPPORTED_DIALECT = 'PostgreSQL dialect is not supported.';

/**
 * Refuses a PostgreSQL database.
 *
 * Only `spanner_list_table_names` and the two search tools work against a
 * PostgreSQL dialect database; everything else queries `INFORMATION_SCHEMA`
 * with GoogleSQL syntax. adk-python writes this message without a trailing
 * period in `get_table_schema` alone, and the callers reproduce that.
 *
 * @param dialect The dialect the database reported.
 * @param message The message to report.
 * @throws Error if the database speaks PostgreSQL.
 */
export function rejectPostgresql(
  dialect: string | undefined,
  message: string,
): void {
  if (dialect === POSTGRESQL_DIALECT) {
    throw new Error(message);
  }
}

/** The database one tool call reads, and the dialect it speaks. */
export interface SpannerToolCall {
  database: Database;
  dialect: SpannerDatabaseDialect;
}

/** One Spanner tool: its model-facing schema and the reads it performs. */
export interface SpannerToolDefinition<TParams extends z.ZodObject> {
  /** Tool name without the `spanner_` prefix. */
  name: string;
  description: string;
  parameters: TParams;
  /**
   * Rejects arguments that must not reach Spanner, before any client is
   * built. Values that are interpolated into generated SQL are checked here
   * so that an injection attempt never opens a connection.
   */
  validate?(args: ToolExecuteArgument<TParams>): void;
  /** Which database this call works against. */
  target(
    args: ToolExecuteArgument<TParams>,
  ): Omit<SpannerDatabaseTarget, 'authClient'>;
  /** The fields the tool reports under `SUCCESS`. */
  run(
    call: SpannerToolCall,
    args: ToolExecuteArgument<TParams>,
  ): Promise<object>;
}

/**
 * Wraps one Spanner read as a prefixed tool that never throws.
 *
 * Resolving the credentials, loading the optional peer dependency, opening
 * the database and the read itself are all inside the same guard, so every
 * failure reaches the model as an `ERROR` result.
 *
 * @param credentials Resolves the calling end user's Spanner credentials.
 * @param definition What the tool declares and what it reads.
 * @return The tool, named `spanner_<definition.name>`.
 */
export function createSpannerTool<TParams extends z.ZodObject>(
  credentials: SpannerCredentialsManager,
  definition: SpannerToolDefinition<TParams>,
): FunctionTool<TParams> {
  const name = `${SPANNER_TOOL_NAME_PREFIX}_${definition.name}`;
  return new FunctionTool({
    name,
    description: definition.description,
    parameters: definition.parameters,
    execute(args, toolContext): Promise<SpannerToolResult> {
      return runSpannerTool(name, async () => {
        definition.validate?.(args);
        const authClient = await credentials.getAuthClient(toolContext);
        if (!authClient) {
          throw new Error(
            'User authorization is required to access Google services for' +
              ` ${name}. Please complete the authorization flow.`,
          );
        }
        return withSpannerDatabase(
          {...definition.target(args), authClient},
          async (database) => {
            const dialect = await database.getDatabaseDialect();
            return definition.run({database, dialect}, args);
          },
        );
      });
    },
  });
}
