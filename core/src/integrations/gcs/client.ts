/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Storage, StorageOptions} from '@google-cloud/storage';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

/** The feature named in the error raised when the peer is not installed. */
const FEATURE_NAME = 'GcsAdminToolset';

/**
 * Attribution sent to Cloud Storage, matching adk-python's
 * `USER_AGENT = f"adk-gcs-tool google-adk/{version.__version__}"`.
 */
export const GCS_USER_AGENT = `adk-gcs-tool google-adk/${version}`;

/**
 * An auth client `@google-cloud/storage` accepts.
 *
 * Read off the client's own options rather than imported from
 * `google-auth-library`, because `@google-cloud/storage` v7 pins
 * google-auth-library v9 while this package depends on v10. The two
 * `AuthClient` types are not interchangeable, and a v10 client handed to
 * storage sends no `Authorization` header at all, so the type has to come
 * from storage itself for the compiler to reject the mistake.
 */
export type GcsAuthClient = NonNullable<StorageOptions['authClient']>;

/** An OAuth authorized user, as the token cache holds one. */
export interface GcsAuthorizedUser {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The current access token, when one has already been minted. */
  accessToken?: string;
  /** Epoch milliseconds at which `accessToken` expires, if known. */
  expiresAt?: number;
}

/**
 * How one tool call authenticates to Cloud Storage: either a client the
 * developer built, or an authorized user storage builds a client from.
 */
export type GcsCredentials =
  | {authClient: GcsAuthClient}
  | {authorizedUser: GcsAuthorizedUser};

/**
 * Turns resolved credentials into the storage options that carry them.
 *
 * An authorized user is passed as plain JSON rather than as a built client:
 * `@google-cloud/storage` builds the client with the google-auth-library it
 * pins itself, which is the only version whose clients it authenticates with.
 */
function authOptions(credentials: GcsCredentials): StorageOptions {
  if ('authClient' in credentials) {
    return {authClient: credentials.authClient};
  }
  const {clientId, clientSecret, refreshToken, accessToken, expiresAt} =
    credentials.authorizedUser;
  return {
    credentials: {
      type: 'authorized_user',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    },
    clientOptions: {
      credentials: {access_token: accessToken, expiry_date: expiresAt},
    },
  };
}

/**
 * Builds the Cloud Storage client for one tool call.
 *
 * A client is never cached or shared between calls. `credentials` belong to
 * one end user, so a client kept across calls would serve the next user under
 * the previous user's identity.
 *
 * `@google-cloud/storage` is an optional peer dependency and is imported only
 * here, so that importing `@google/adk` never resolves it.
 *
 * @param credentials How this call authenticates.
 * @param projectId The project the call is billed to, when the tool names one.
 * @return The client, for this call only.
 * @throws Error if `@google-cloud/storage` is not installed.
 */
export async function createStorageClient(
  credentials: GcsCredentials,
  projectId?: string,
): Promise<Storage> {
  const {Storage: StorageClient} = await loadOptionalPeer(
    {packageName: '@google-cloud/storage', feature: FEATURE_NAME},
    () => import('@google-cloud/storage'),
  );
  return new StorageClient({
    ...authOptions(credentials),
    userAgent: GCS_USER_AGENT,
    ...(projectId === undefined ? {} : {projectId}),
  });
}
