/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bigtable} from '@google-cloud/bigtable';

import {
  BIGTABLE_DEFAULT_SCOPE,
  BigtableCredentialsConfig,
} from './bigtable_credentials.js';

/**
 * Creates a Bigtable client for a project.
 *
 * The SDK is imported on demand, and the import above is type-only, so that
 * merely importing `@google/adk` does not pull in `@google-cloud/bigtable`.
 * That matters because the SDK reads
 * `protos/google/bigtable/v2/response_params.proto` off disk relative to
 * `__dirname` while its module is evaluating
 * (`client-side-metrics/operation-metrics-collector.js`), which throws in a
 * bundled agent.
 *
 * The credentials config is the auth subset of the SDK's own options, so it is
 * spread straight into the constructor. The API endpoint is deliberately left
 * unset so the SDK default still applies and callers keep the ability to point
 * at the emulator or a regional endpoint.
 */
export async function createBigtableClient(
  projectId: string,
  config?: BigtableCredentialsConfig,
): Promise<Bigtable> {
  const {Bigtable} = await import('@google-cloud/bigtable');
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
  // The promise is cached rather than the client so that concurrent tool calls
  // for the same project share one client instead of racing to create two.
  private readonly clients = new Map<string, Promise<Bigtable>>();

  constructor(private readonly config?: BigtableCredentialsConfig) {}

  /** Returns the pooled client for `projectId`, creating it on first use. */
  forProject(projectId: string): Promise<Bigtable> {
    let client = this.clients.get(projectId);
    if (!client) {
      client = createBigtableClient(projectId, this.config);
      this.clients.set(projectId, client);
    }
    return client;
  }

  /** Closes every client this pool opened and empties the pool. */
  async close(): Promise<void> {
    const pending = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(pending.map(async (client) => (await client).close()));
  }
}
