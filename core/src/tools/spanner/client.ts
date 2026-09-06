/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Database, SpannerOptions} from '@google-cloud/spanner';
import type {AuthClient} from 'google-auth-library';
import {z} from 'zod';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer, OptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';
import {SpannerToolResult, SpannerToolStatus} from './spanner_tool.js';

/** The optional peer dependency backing every Spanner tool. */
export const SPANNER_PEER: OptionalPeer = {
  packageName: '@google-cloud/spanner',
  feature: 'SpannerToolset',
};

/**
 * The library name half of the user agent the Spanner tools stamp on their
 * requests. `google-gax` composes the user agent as
 * `` `${libName}/${libVersion}` ``, so this pairs with {@link version} to
 * produce `adk-spanner-tool google-adk/<version>`, the same string
 * adk-python sends.
 */
const USER_AGENT_LIB_NAME = 'adk-spanner-tool google-adk';

/**
 * `libName` and `libVersion` are honoured by the Spanner client at runtime —
 * it merges them over its own defaults — but they are declared on
 * `google-gax`'s `ClientOptions` rather than on `SpannerOptions`.
 */
interface SpannerClientOptions extends SpannerOptions {
  libName?: string;
  libVersion?: string;
}

/** The database parameters every per-database Spanner tool declares. */
export const databaseParameters = {
  project_id: z.string().describe('The Google Cloud project id.'),
  instance_id: z.string().describe('The Spanner instance id.'),
  database_id: z.string().describe('The Spanner database id.'),
};

/** The database arguments a tool call carries, as {@link databaseParameters} declares them. */
export type SpannerDatabaseArgs = z.infer<
  z.ZodObject<typeof databaseParameters>
>;

/** Which Spanner database a tool call runs against, and as whom. */
export interface SpannerDatabaseTarget {
  projectId: string;
  instanceId: string;
  databaseId: string;
  /** The auth client, or `undefined` to use application default credentials. */
  credentials?: AuthClient;
  /** The database role the session runs as. */
  databaseRole?: string;
}

/** Turns a tool call's database arguments into the target it connects to. */
export function databaseTarget(
  args: SpannerDatabaseArgs,
  credentials: AuthClient | undefined,
  databaseRole?: string,
): SpannerDatabaseTarget {
  return {
    projectId: args.project_id,
    instanceId: args.instance_id,
    databaseId: args.database_id,
    credentials,
    databaseRole,
  };
}

/**
 * Opens a Spanner database, runs `use` against it, and releases the database
 * and the client on every exit path.
 *
 * The SDK is loaded lazily, so an application that never builds a
 * `SpannerToolset` never pays for it.
 *
 * @param target The database to open and the credentials to open it with.
 * @param use What to run against the open database.
 * @return Whatever `use` returns.
 */
export async function withSpannerDatabase<T>(
  target: SpannerDatabaseTarget,
  use: (database: Database) => Promise<T>,
): Promise<T> {
  const {Spanner} = await loadOptionalPeer(
    SPANNER_PEER,
    () => import('@google-cloud/spanner'),
  );
  const options: SpannerClientOptions = {
    projectId: target.projectId,
    authClient: target.credentials,
    libName: USER_AGENT_LIB_NAME,
    libVersion: version,
  };
  const client = new Spanner(options);
  let database: Database | undefined;
  try {
    database = client
      .instance(target.instanceId)
      .database(target.databaseId, undefined, undefined, target.databaseRole);
    return await use(database);
  } finally {
    // An error raised while releasing a resource would replace the result
    // about to be returned, so every failure here is logged instead.
    const opened = database;
    if (opened) {
      await closeQuietly('database', () => opened.close());
    }
    await closeQuietly('client', () => client.close());
  }
}

/** Closes one resource, logging instead of raising when cleanup fails. */
async function closeQuietly(
  resource: string,
  close: () => Promise<unknown>,
): Promise<void> {
  try {
    await close();
  } catch (err: unknown) {
    logger.warn(`Failed to close the Spanner ${resource}.`, err);
  }
}

/** The dialect value `Database.getDatabaseDialect` reports for GoogleSQL. */
export const GOOGLE_STANDARD_SQL_DIALECT = 'GOOGLE_STANDARD_SQL';

/** The dialect value `Database.getDatabaseDialect` reports for PostgreSQL. */
export const POSTGRESQL_DIALECT = 'POSTGRESQL';

/**
 * Rejects a PostgreSQL database, whose `INFORMATION_SCHEMA` layout and query
 * syntax the GoogleSQL-only tools do not support.
 *
 * @param database The open database.
 * @return The error result to return, or `undefined` when the dialect is fine.
 */
export async function rejectPostgresql(
  database: Database,
): Promise<SpannerToolResult | undefined> {
  const dialect = await database.getDatabaseDialect();
  if (dialect !== POSTGRESQL_DIALECT) {
    return undefined;
  }
  return {
    status: SpannerToolStatus.ERROR,
    error_details: 'PostgreSQL dialect is not supported.',
  };
}
