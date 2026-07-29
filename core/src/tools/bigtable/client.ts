/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Bigtable} from '@google-cloud/bigtable';

import {
  BIGTABLE_DEFAULT_SCOPE,
  BigtableCredentialsConfig,
} from './bigtable_credentials.js';

/**
 * Creates a Bigtable client for a project.
 *
 * The credentials config is the auth subset of the SDK's own options, so it is
 * spread straight into the constructor. The API endpoint is deliberately left
 * unset so the SDK default still applies and callers keep the ability to point
 * at the emulator or a regional endpoint.
 */
export function createBigtableClient(
  projectId: string,
  config?: BigtableCredentialsConfig,
): Bigtable {
  return new Bigtable({
    ...config,
    projectId,
    scopes: config?.scopes ?? BIGTABLE_DEFAULT_SCOPE,
  });
}

/**
 * Lazily creates and owns one Bigtable client per project id, all built with
 * the same credentials.
 *
 * Clients are never shared between pools, so two toolsets configured with
 * different credentials cannot end up using each other's client, and closing a
 * pool only closes the connections that pool opened.
 */
export class BigtableClientPool {
  private readonly clients = new Map<string, Bigtable>();

  constructor(private readonly config?: BigtableCredentialsConfig) {}

  /** Returns the pooled client for `projectId`, creating it on first use. */
  forProject(projectId: string): Bigtable {
    const cached = this.clients.get(projectId);
    if (cached) {
      return cached;
    }

    const client = createBigtableClient(projectId, this.config);
    this.clients.set(projectId, client);
    return client;
  }

  /** Closes every client this pool opened and empties the pool. */
  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close()));
  }
}
