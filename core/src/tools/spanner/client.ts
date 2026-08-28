/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {v1} from '@google-cloud/spanner-api';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

/** OAuth scope required by the Spanner Admin API. */
const SPANNER_ADMIN_SCOPE = 'https://www.googleapis.com/auth/spanner.admin';

/** The feature named in the error raised when the peer is not installed. */
const FEATURE_NAME = 'SpannerAdminToolset';

/**
 * Attribution sent to the Spanner Admin API, matching adk-python's
 * `USER_AGENT = f"adk-spanner-tool google-adk/{version.__version__}"`.
 */
const CLIENT_LIB_NAME = 'adk-spanner-tool google-adk';

/**
 * Options the Spanner Admin API clients accept: `credentials`, `keyFilename`,
 * `authClient`, `projectId`, `apiEndpoint` and the rest of google-gax's
 * `ClientOptions`. Read off the client itself, so the credential types are the
 * ones the client expects.
 */
export type SpannerAdminClientOptions = NonNullable<
  ConstructorParameters<typeof v1.InstanceAdminClient>[0]
>;

/** The two Spanner Admin API clients the admin tools call. */
export interface SpannerAdminClients {
  instanceAdmin: v1.InstanceAdminClient;
  databaseAdmin: v1.DatabaseAdminClient;
}

/**
 * Builds and owns the Spanner Admin API clients.
 *
 * The clients hold gRPC channels, so they have a lifecycle: they are created
 * on first tool call, shared by every later call, and released by
 * {@link close}. `@google-cloud/spanner-api` is an optional peer dependency
 * and is imported only here, inside {@link getClients}, so that importing
 * `@google/adk` never resolves it.
 */
export class SpannerAdminClientProvider {
  private clientsPromise?: Promise<SpannerAdminClients>;

  /**
   * @param options Client options. Both clients use Application Default
   *   Credentials scoped to the Spanner admin scope; anything given here
   *   overrides that.
   */
  constructor(private readonly options?: SpannerAdminClientOptions) {}

  /** Returns the admin clients, creating them on first use. */
  getClients(): Promise<SpannerAdminClients> {
    this.clientsPromise ??= this.createClients();
    return this.clientsPromise;
  }

  /**
   * Closes both admin clients and drops them, so the next tool call builds a
   * fresh pair. `Runner` closes every toolset in the agent tree at the end of
   * each turn, and a closed gax client rejects every later call, so a provider
   * that kept the closed clients would serve one turn and fail on the next.
   *
   * Safe to call twice, and safe to call when no tool ever ran, in which case
   * no client was created and there is nothing to release.
   */
  async close(): Promise<void> {
    const closing = this.clientsPromise;
    this.clientsPromise = undefined;
    // A provider whose clients failed to build has nothing to release either.
    const clients = await closing?.catch(() => undefined);
    if (!clients) {
      return;
    }
    await Promise.all([
      clients.instanceAdmin.close(),
      clients.databaseAdmin.close(),
    ]);
  }

  private async createClients(): Promise<SpannerAdminClients> {
    const {v1: spannerV1} = await loadOptionalPeer(
      {packageName: '@google-cloud/spanner-api', feature: FEATURE_NAME},
      () => import('@google-cloud/spanner-api'),
    );
    const options = {
      scopes: [SPANNER_ADMIN_SCOPE],
      libName: CLIENT_LIB_NAME,
      libVersion: version,
      ...this.options,
    };
    return {
      instanceAdmin: new spannerV1.InstanceAdminClient(options),
      databaseAdmin: new spannerV1.DatabaseAdminClient(options),
    };
  }
}
