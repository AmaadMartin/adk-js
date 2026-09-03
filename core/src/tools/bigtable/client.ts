/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bigtable} from '@google-cloud/bigtable';

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';

import {
  BIGTABLE_DEFAULT_SCOPES,
  BigtableCredentialsConfig,
} from './bigtable_credentials.js';

const BIGTABLE_PEER = {
  packageName: '@google-cloud/bigtable',
  feature: 'BigtableToolset',
};

/**
 * Builds a Bigtable client for one project.
 *
 * The SDK is loaded here rather than imported at the top of the module, so
 * that `import '@google/adk'` does not pull it in for the applications that
 * never touch Bigtable.
 */
async function createClient(
  projectId: string,
  credentialsConfig?: BigtableCredentialsConfig,
): Promise<Bigtable> {
  const {Bigtable} = await loadOptionalPeer(
    BIGTABLE_PEER,
    () => import('@google-cloud/bigtable'),
  );
  return new Bigtable({
    projectId,
    ...credentialsConfig,
    scopes: credentialsConfig?.scopes ?? BIGTABLE_DEFAULT_SCOPES,
  });
}

/**
 * The Bigtable clients a toolset has opened, one per project id.
 *
 * A client owns gRPC channels, so it is created once per project and closed
 * when the toolset is closed.
 */
export class BigtableClientCache {
  private readonly clients = new Map<string, Promise<Bigtable>>();

  constructor(private readonly credentialsConfig?: BigtableCredentialsConfig) {}

  /**
   * Returns the client for `projectId`, creating it on first use.
   *
   * @param projectId The Google Cloud project the tool is reading.
   * @return The cached client.
   */
  get(projectId: string): Promise<Bigtable> {
    const cached = this.clients.get(projectId);
    if (cached !== undefined) {
      return cached;
    }
    const client = createClient(projectId, this.credentialsConfig);
    this.clients.set(projectId, client);
    return client;
  }

  /**
   * Closes every client this cache opened and empties it.
   *
   * One client that fails to close, or one that never finished being created,
   * must not keep the others open, so every outcome is settled before this
   * resolves.
   */
  async close(): Promise<void> {
    const pending = [...this.clients.values()];
    this.clients.clear();
    const outcomes = await Promise.allSettled(
      pending.map((client) => client.then((opened) => opened.close())),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        logger.warn(
          `Closing a Bigtable client failed: ${formatError(outcome.reason)}`,
        );
      }
    }
  }
}
