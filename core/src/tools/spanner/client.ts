/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Database, protos, Snapshot, Spanner} from '@google-cloud/spanner';
import {OAuth2Client} from 'google-auth-library';
import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

/** The feature named in the error raised when the peer is not installed. */
const FEATURE_NAME = 'SpannerToolset';

/**
 * The same, for the admin tools. They are a separate toolset, so a developer
 * who installed neither is told which one they reached.
 */
const ADMIN_FEATURE_NAME = 'SpannerAdminToolset';

/** The options `new Spanner(...)` accepts. */
type SpannerConstructorOptions = NonNullable<
  ConstructorParameters<typeof Spanner>[0]
>;

/**
 * An auth client the Spanner client accepts. Read off the client's own
 * options rather than imported from `google-auth-library`, because
 * `@google-cloud/spanner` types this field with the copy of that package
 * `google-gax` pins.
 */
export type SpannerAuthClient = NonNullable<
  NonNullable<ConstructorParameters<typeof Spanner>[0]>['authClient']
>;

/**
 * `libName` and `libVersion` are honoured by the generated Spanner clients,
 * which append them to the `x-goog-api-client` header, but
 * `@google-cloud/spanner` does not declare them on its own options type.
 */
interface SpannerClientOptions extends SpannerConstructorOptions {
  libName: string;
  libVersion: string;
}

/**
 * The dialect names `Database.getDatabaseDialect` reports. Spelled out rather
 * than derived from the method, whose callback overload makes `ReturnType`
 * resolve to `void`; the names are the keys of the SDK's `DatabaseDialect`
 * enum, and `undefined` is what an unloaded database reports.
 */
export type SpannerDatabaseDialect =
  | keyof typeof protos.google.spanner.admin.database.v1.DatabaseDialect
  | undefined;

/** An OAuth access token, as cached in session state. */
export interface SpannerAccessToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds at which `accessToken` expires, if known. */
  expiresAt?: number;
}

/** The OAuth client a refresh token is renewed against. */
export interface SpannerOAuthClientCredentials {
  clientId?: string;
  clientSecret?: string;
}

/**
 * Builds an auth client that presents `token` to Spanner.
 *
 * @param token The access token, and the refresh token when there is one.
 * @param oauthClient The OAuth client the refresh token is renewed against.
 * @return The auth client.
 */
export async function createTokenAuthClient(
  token: SpannerAccessToken,
  oauthClient: SpannerOAuthClientCredentials = {},
): Promise<OAuth2Client> {
  const client = new OAuth2Client(oauthClient);
  client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiresAt,
  });
  return client;
}

/**
 * Attribution sent to Spanner, matching adk-python's
 * `USER_AGENT = f"adk-spanner-tool google-adk/{version.__version__}"`.
 */
const CLIENT_LIB_NAME = 'adk-spanner-tool google-adk';

/** Which database one tool call works against, and as whom. */
export interface SpannerDatabaseTarget {
  projectId: string;
  instanceId: string;
  databaseId: string;
  authClient: SpannerAuthClient;
  /** The database role the session runs as, if the settings name one. */
  databaseRole?: string;
}

/** The instance administration endpoint, as `Spanner` hands it out. */
export type SpannerInstanceAdminClient = ReturnType<
  Spanner['getInstanceAdminClient']
>;

/** The database administration endpoint, as `Spanner` hands it out. */
export type SpannerDatabaseAdminClient = ReturnType<
  Spanner['getDatabaseAdminClient']
>;

/** Which project one admin call is made against, and as whom. */
export interface SpannerAdminTarget {
  projectId: string;
  authClient: SpannerAuthClient;
}

/**
 * A long-running operation an admin create call returns.
 *
 * Declared structurally rather than imported from `google-gax`, which reaches
 * this module only as a transitive dependency of the optional peer.
 */
export interface SpannerLongRunningOperation {
  promise(): Promise<unknown>;
  cancel(): Promise<unknown>;
}

/**
 * How long {@link waitForOperation} waits, matching adk-python's
 * `operation.result(timeout=300)` in `admin_tool.py`.
 */
export const OPERATION_TIMEOUT_MS = 300_000;

/**
 * Closes one resource, logging instead of throwing when cleanup fails.
 *
 * Callers run this while unwinding, where a failure to release a resource
 * would replace the result they are about to return.
 */
async function closeQuietly(
  resource: string,
  close: () => Promise<unknown>,
): Promise<void> {
  try {
    await close();
  } catch (err: unknown) {
    logger.warn(`Failed to close the Spanner ${resource}: ${formatError(err)}`);
  }
}

/**
 * Opens a Spanner database for one tool call, runs `use` against it, and
 * closes the database and the client again.
 *
 * Both hold gRPC channels, so they are released on every exit path. They are
 * not shared between calls because `authClient` belongs to one end user: a
 * client kept across calls would serve the next user under the previous
 * user's identity.
 *
 * `@google-cloud/spanner` is an optional peer dependency and is imported only
 * here, so that importing `@google/adk` never resolves it.
 *
 * @param target The database to open and the identity to open it as.
 * @param use What to do with the database.
 * @return Whatever `use` returns.
 */
export async function withSpannerDatabase<T>(
  target: SpannerDatabaseTarget,
  use: (database: Database) => Promise<T>,
): Promise<T> {
  const {Spanner: SpannerClient} = await loadOptionalPeer(
    {packageName: '@google-cloud/spanner', feature: FEATURE_NAME},
    () => import('@google-cloud/spanner'),
  );
  const options: SpannerClientOptions = {
    projectId: target.projectId,
    authClient: target.authClient,
    libName: CLIENT_LIB_NAME,
    libVersion: version,
  };
  const client = new SpannerClient(options);
  try {
    const database = client
      .instance(target.instanceId)
      .database(target.databaseId, undefined, undefined, target.databaseRole);
    try {
      return await use(database);
    } finally {
      await closeQuietly('database', () => database.close());
    }
  } finally {
    await closeQuietly('client', () => client.close());
  }
}

/**
 * Opens a read-only snapshot on `database`, runs `use` against it, and ends
 * the snapshot again so its session returns to the pool.
 *
 * Every Spanner tool reads through a snapshot: none of them writes, and a
 * snapshot also gives the three statements of `spanner_get_table_schema` one
 * consistent view of `INFORMATION_SCHEMA`.
 *
 * @param database The database to read.
 * @param use What to run against the snapshot.
 * @return Whatever `use` returns.
 */
export async function withSnapshot<T>(
  database: Database,
  use: (snapshot: Snapshot) => Promise<T>,
): Promise<T> {
  const [snapshot] = await database.getSnapshot();
  try {
    return await use(snapshot);
  } finally {
    snapshot.end();
  }
}

/**
 * Opens a Spanner client for one admin call, hands `use` the administration
 * endpoint `select` picks off it, and closes the client again.
 *
 * The client holds gRPC channels, so it is released on every exit path. It is
 * not shared between calls because `authClient` belongs to one end user: a
 * client kept across calls would serve the next user under the previous
 * user's identity. The endpoint itself belongs to the client —
 * `Spanner.close()` closes every endpoint it handed out — so only the client
 * is closed here.
 *
 * `@google-cloud/spanner` is an optional peer dependency and is imported only
 * here, so that importing `@google/adk` never resolves it.
 */
async function withAdminClient<TAdmin, T>(
  target: SpannerAdminTarget,
  select: (client: Spanner) => TAdmin,
  use: (admin: TAdmin) => Promise<T>,
): Promise<T> {
  const {Spanner: SpannerClient} = await loadOptionalPeer(
    {packageName: '@google-cloud/spanner', feature: ADMIN_FEATURE_NAME},
    () => import('@google-cloud/spanner'),
  );
  const options: SpannerClientOptions = {
    projectId: target.projectId,
    authClient: target.authClient,
    libName: CLIENT_LIB_NAME,
    libVersion: version,
  };
  const client = new SpannerClient(options);
  try {
    return await use(select(client));
  } finally {
    await closeQuietly('client', () => client.close());
  }
}

/**
 * Runs `use` against the instance administration endpoint of one project.
 *
 * @param target The project to administer and the identity to act as.
 * @param use What to do with the endpoint.
 * @return Whatever `use` returns.
 */
export function withInstanceAdminClient<T>(
  target: SpannerAdminTarget,
  use: (admin: SpannerInstanceAdminClient) => Promise<T>,
): Promise<T> {
  return withAdminClient(
    target,
    (client) => client.getInstanceAdminClient(),
    use,
  );
}

/**
 * Runs `use` against the database administration endpoint of one project.
 *
 * @param target The project to administer and the identity to act as.
 * @param use What to do with the endpoint.
 * @return Whatever `use` returns.
 */
export function withDatabaseAdminClient<T>(
  target: SpannerAdminTarget,
  use: (admin: SpannerDatabaseAdminClient) => Promise<T>,
): Promise<T> {
  return withAdminClient(
    target,
    (client) => client.getDatabaseAdminClient(),
    use,
  );
}

/**
 * Waits for one long-running operation, giving up after
 * {@link OPERATION_TIMEOUT_MS}.
 *
 * The bound matters because a tool call blocks the agent turn: an instance
 * that never finishes provisioning would otherwise hold it open forever. On
 * timeout the operation is cancelled, because `google-gax` polls with an
 * infinite deadline by default and would otherwise keep polling after the
 * tool has answered.
 *
 * @param operation The operation the create call returned.
 * @throws Error if the operation fails, or does not finish in time.
 */
export async function waitForOperation(
  operation: SpannerLongRunningOperation,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      operation.promise(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              'The Spanner operation did not complete within' +
                ` ${OPERATION_TIMEOUT_MS} ms.`,
            ),
          );
        }, OPERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      await closeQuietly('operation', () => operation.cancel());
    }
  }
}
