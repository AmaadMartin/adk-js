/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Storage, StorageOptions} from '@google-cloud/storage';
import {AuthClient} from 'google-auth-library';

import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

/** The optional peer the Cloud Storage tools load on their first call. */
export const GCS_PEER = {
  packageName: '@google-cloud/storage',
  feature: 'GcsAdminToolset',
};

/** The tag Cloud Storage sees on every request an admin tool makes. */
export const GCS_USER_AGENT = `adk-gcs-tool google-adk/${version}`;

/** The auth client `@google-cloud/storage` accepts. */
type StorageAuthClient = NonNullable<StorageOptions['authClient']>;

/** What {@link getGcsClient} needs to authenticate a Cloud Storage client. */
export interface GcsClientOptions {
  /** The credential the client authenticates as. */
  credentials?: AuthClient;
  /** The Google Cloud project id, for the calls that are project-scoped. */
  project?: string;
}

/**
 * Copies a `Headers` into the plain object the older contract expects.
 *
 * `Object.fromEntries` would say this in one line, but this repository's `lib`
 * is `["ES2022", "DOM"]` with no `dom.iterable`, so the `Headers` type here
 * declares neither `[Symbol.iterator]` nor `entries()`. `forEach` is the only
 * accessor it does declare.
 */
function plainHeaders(headers: Headers): Record<string, string> {
  const plain: Record<string, string> = {};
  headers.forEach((value, key) => {
    plain[key] = value;
  });
  return plain;
}

/**
 * Adapts adk's auth client to the contract `@google-cloud/storage` expects.
 *
 * `@google-cloud/storage@7` pins `google-auth-library@^9` and adk pins `^10`,
 * so npm keeps two copies and they disagree on `getRequestHeaders()`. v10
 * resolves it to a WHATWG `Headers`, whose entries are not own enumerable
 * properties. v9 merges the result with `Object.assign` (`googleauth.js`,
 * `authorizeRequest`), which copies nothing off a `Headers`, so the
 * `Authorization` header is dropped and every request goes out
 * unauthenticated. Resolving to a plain object restores it.
 *
 * `core/test/integrations/gcs/storage_auth_test.ts` is what guards this. It
 * has to be: a mocked storage client cannot show a header reaching the wire,
 * and the compiler does not reject the unadapted client either, because the
 * two declarations are loose enough in both directions here.
 *
 * `gaxios` is v10's `transporter` under its old name. Nothing in the storage
 * stack reads it, but the v9 contract declares it, so leaving it out is itself
 * a type error.
 *
 * Delegation is through the prototype, so the adapter keeps the client's own
 * token refresh and the storage stack still reads every other member off it.
 *
 * @param client The credential the tool resolved for this call.
 * @return The same credential, speaking the older contract.
 */
export function asStorageAuthClient(client: AuthClient): StorageAuthClient {
  const delegate: AuthClient = Object.create(client);
  const adapter = Object.assign(delegate, {
    getRequestHeaders: async (url?: string) =>
      plainHeaders(await client.getRequestHeaders(url)),
    gaxios: client.transporter,
  });
  // The two copies of the `gaxios` package declare incompatible `Gaxios`
  // types, so `transporter` cannot satisfy both. The directive sits on the
  // return because that is where the compiler reports it; a directive on the
  // property is unused (TS2578) and the error stands. It therefore covers the
  // adaptation above as well, which is why that is pinned by the test named
  // above rather than by the compiler.
  // @ts-expect-error incompatible Gaxios types across two google-auth-library copies
  return adapter;
}

/**
 * Builds a Cloud Storage client, loading the `@google-cloud/storage` optional
 * peer on first use.
 *
 * Every call builds its own client. Two end users of one agent hold different
 * credentials, so a cached client would serve one user's buckets to another.
 *
 * @param options The credential and, when the call is project-scoped, the
 *     project id.
 * @return A Cloud Storage client authenticated as `options.credentials`.
 */
export async function getGcsClient(
  options: GcsClientOptions,
): Promise<Storage> {
  const {Storage: StorageClass} = await loadOptionalPeer(
    GCS_PEER,
    () => import('@google-cloud/storage'),
  );

  const storageOptions: StorageOptions = {userAgent: GCS_USER_AGENT};
  if (options.project !== undefined) {
    storageOptions.projectId = options.project;
  }
  if (options.credentials) {
    storageOptions.authClient = asStorageAuthClient(options.credentials);
  }

  return new StorageClass(storageOptions);
}
