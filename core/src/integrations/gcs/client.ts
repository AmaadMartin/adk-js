/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Storage, StorageOptions} from '@google-cloud/storage';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

/**
 * Prepended to the SDK's own User-Agent header, so Cloud Storage traffic an
 * ADK tool produces is distinguishable from an application's own traffic.
 * Matches the tag adk-python sends.
 */
const USER_AGENT = `adk-gcs-tool google-adk/${version}`;

/**
 * Builds a Cloud Storage client, loading the `@google-cloud/storage` optional
 * peer on first use.
 *
 * With no options the client uses Application Default Credentials.
 *
 * @param options Options forwarded to the `Storage` constructor. A `userAgent`
 *   given here replaces the ADK one.
 * @return The client.
 * @throws If `@google-cloud/storage` is not installed.
 */
export async function getGcsClient(options?: StorageOptions): Promise<Storage> {
  const {Storage: StorageClient} = await loadOptionalPeer(
    {packageName: '@google-cloud/storage', feature: 'GcsAdminToolset'},
    () => import('@google-cloud/storage'),
  );
  return new StorageClient({userAgent: USER_AGENT, ...options});
}
