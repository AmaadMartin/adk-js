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

/** What {@link getGcsClient} needs to authenticate a Cloud Storage client. */
export interface GcsClientOptions {
  /** The credential the client authenticates as. */
  credentials?: AuthClient;
  /** The Google Cloud project id, for the calls that are project-scoped. */
  project?: string;
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
    // The suppression covers the value alone: `@google-cloud/storage@7` pins
    // `google-auth-library@^9`, while adk pins `^10`, so npm keeps two copies
    // and their `AuthClient` declarations are nominally distinct. Only v9
    // declares `gaxios`; the storage client calls neither that member nor any
    // other member the two copies disagree on. The assignment below stays
    // type-checked, so renaming or removing the option still fails the build.
    // @ts-expect-error two nominally distinct google-auth-library copies
    const authClient: StorageOptions['authClient'] = options.credentials;
    storageOptions.authClient = authClient;
  }

  return new StorageClass(storageOptions);
}
