/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {v1} from '@google-cloud/spanner-api';
import type {googleAuthLibrary} from 'google-gax';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

/** The feature named in the error raised when the peer is not installed. */
const FEATURE_NAME = 'SpannerAdminToolset';

/**
 * An auth client the Spanner Admin API clients accept.
 *
 * Read off the client rather than imported from `google-auth-library`, because
 * `google-gax` pins its own copy of that package. The two copies declare
 * structurally different `AuthClient` types, so naming ours here would not
 * typecheck against the client that actually receives it.
 */
export type SpannerAuthClient = NonNullable<
  NonNullable<
    ConstructorParameters<typeof v1.InstanceAdminClient>[0]
  >['authClient']
>;

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
 * Builds an auth client that presents `token` to the Spanner Admin API.
 *
 * The client comes from `google-gax`'s own copy of `google-auth-library`, not
 * from the copy this package depends on, so that its type is the one the admin
 * clients accept. `google-gax` is a required dependency of
 * `@google-cloud/spanner-api`, so it is present whenever that peer is.
 */
export async function createTokenAuthClient(
  token: SpannerAccessToken,
  oauthClient: SpannerOAuthClientCredentials = {},
): Promise<googleAuthLibrary.OAuth2Client> {
  const {googleAuthLibrary: authLibrary} = await loadOptionalPeer(
    {packageName: 'google-gax', feature: FEATURE_NAME},
    () => import('google-gax'),
  );
  const client = new authLibrary.OAuth2Client(oauthClient);
  client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiresAt,
  });
  return client;
}

/**
 * Attribution sent to the Spanner Admin API, matching adk-python's
 * `USER_AGENT = f"adk-spanner-tool google-adk/{version.__version__}"`.
 */
const CLIENT_LIB_NAME = 'adk-spanner-tool google-adk';

/** The two Spanner Admin API clients the admin tools call. */
export interface SpannerAdminClients {
  instanceAdmin: v1.InstanceAdminClient;
  databaseAdmin: v1.DatabaseAdminClient;
}

/**
 * Builds the Spanner Admin API clients for one tool call, runs `use` against
 * them, and closes them again.
 *
 * The clients hold gRPC channels, so `use` receives them for the length of one
 * call only and the channels are released on every exit path. They are not
 * shared between calls because `authClient` belongs to one end user: a client
 * kept across calls would serve the next user under the previous user's
 * identity.
 *
 * `@google-cloud/spanner-api` is an optional peer dependency and is imported
 * only here, so that importing `@google/adk` never resolves it.
 */
export async function withSpannerAdminClients<T>(
  authClient: SpannerAuthClient,
  use: (clients: SpannerAdminClients) => Promise<T>,
): Promise<T> {
  const {v1: spannerV1} = await loadOptionalPeer(
    {packageName: '@google-cloud/spanner-api', feature: FEATURE_NAME},
    () => import('@google-cloud/spanner-api'),
  );
  const options = {
    authClient,
    libName: CLIENT_LIB_NAME,
    libVersion: version,
  };
  const clients: SpannerAdminClients = {
    instanceAdmin: new spannerV1.InstanceAdminClient(options),
    databaseAdmin: new spannerV1.DatabaseAdminClient(options),
  };
  try {
    return await use(clients);
  } finally {
    await Promise.all([
      clients.instanceAdmin.close(),
      clients.databaseAdmin.close(),
    ]);
  }
}
