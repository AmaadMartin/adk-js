/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bigtable, BigtableOptions} from '@google-cloud/bigtable';
import type {AuthClient} from 'google-auth-library';

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

/** The optional peer the Bigtable tools load on their first call. */
export const BIGTABLE_PEER = {
  packageName: '@google-cloud/bigtable',
  feature: 'BigtableToolset',
};

/**
 * How the Bigtable tools identify themselves to the service.
 *
 * `BigtableOptions` exposes no top-level slot for it, so it goes on the three
 * generated clients the `Bigtable` constructor builds.
 */
export const BIGTABLE_CLIENT_INFO = {
  libName: 'adk-bigtable-tool',
  libVersion: version,
};

/**
 * The key a project and its credentials share.
 *
 * The access token belongs in the key because a client resolves its
 * credentials once, at construction. Keying on the project alone would let
 * one end user's call replace another user's client for the same project.
 *
 * @param projectId The Google Cloud project the client reads.
 * @param credentials The credentials the client authenticates with.
 * @return The key the pool stores the client under.
 */
function poolKey(projectId: string, credentials?: AuthClient): string {
  return `${projectId}\n${credentials?.credentials.access_token ?? ''}`;
}

/** Opens a Bigtable client, loading the SDK on first use. */
async function createClient(
  projectId: string,
  credentials?: AuthClient,
): Promise<Bigtable> {
  const {Bigtable: BigtableClient} = await loadOptionalPeer(
    BIGTABLE_PEER,
    () => import('@google-cloud/bigtable'),
  );
  const options: BigtableOptions = {
    projectId,
    BigtableClient: BIGTABLE_CLIENT_INFO,
    BigtableInstanceAdminClient: BIGTABLE_CLIENT_INFO,
    BigtableTableAdminClient: BIGTABLE_CLIENT_INFO,
  };
  if (credentials) {
    // The suppression covers the value alone: `authClient` is typed against
    // the google-auth-library copy nested under google-gax, while adk
    // resolves its own copy, so the two `AuthClient` declarations are
    // nominally distinct although this is the object the SDK calls
    // `getRequestHeaders()` on. The assignment below stays type-checked, so
    // renaming or removing the option still fails the build.
    // @ts-expect-error two nominally distinct google-auth-library copies
    const authClient: BigtableOptions['authClient'] = credentials;
    options.authClient = authClient;
  }
  return new BigtableClient(options);
}

/** Closes a client that is being replaced, reporting a failure to the log. */
async function closeQuietly(client: Promise<Bigtable>): Promise<void> {
  try {
    await (await client).close();
  } catch (e: unknown) {
    logger.debug(`Closing a Bigtable client failed: ${formatError(e)}`);
  }
}

/**
 * Opens Bigtable clients on demand and keeps one per project and caller.
 *
 * A client owns gRPC channels, so opening one per tool call would leak them.
 * Two end users of one project hold two clients: closing a client tears down
 * its channels, so releasing one to make room for the other would fail a
 * query in flight. Nothing is closed until {@link close}.
 */
export class BigtableClientPool {
  private readonly clients = new Map<string, Promise<Bigtable>>();

  /**
   * Returns the client for a project and its credentials, opening one if
   * there is none.
   *
   * @param projectId The Google Cloud project the client reads.
   * @param credentials The credentials to authenticate with, or `undefined`
   *     to let the SDK find application default credentials.
   * @return The client, once the Bigtable package has loaded.
   */
  get(projectId: string, credentials?: AuthClient): Promise<Bigtable> {
    const key = poolKey(projectId, credentials);
    const pooled = this.clients.get(key);
    if (pooled) {
      return pooled;
    }

    const client = createClient(projectId, credentials);
    this.clients.set(key, client);
    return client;
  }

  /** Releases every client this pool opened. Safe to call more than once. */
  async close(): Promise<void> {
    const pending = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(pending.map(closeQuietly));
  }
}
