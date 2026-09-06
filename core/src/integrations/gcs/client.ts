/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Storage} from '@google-cloud/storage';

import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';
import {GCS_DEFAULT_SCOPE, GcsCredentialsConfig} from './gcs_credentials.js';

/** Identifies ADK's Cloud Storage tools to the service. */
export const GCS_TOOL_USER_AGENT = `adk-gcs-tool google-adk/${version}`;

/**
 * Builds a Cloud Storage client for the Cloud Storage tools.
 *
 * Loads `@google-cloud/storage` on first use, so importing `@google/adk`
 * keeps working when the optional peer is not installed.
 *
 * A fresh client is returned on every call, as adk-python's `get_gcs_client`
 * does, so one caller's credentials can never reach another's client.
 *
 * @param config How to authenticate. Defaults to Application Default
 *   Credentials with {@link GCS_DEFAULT_SCOPE}.
 * @param project The project id to bill and to scope requests to. Left to the
 *   SDK's own resolution when omitted.
 * @return The Cloud Storage client.
 */
export async function createGcsClient(
  config?: GcsCredentialsConfig,
  project?: string,
): Promise<Storage> {
  const {Storage} = await loadOptionalPeer(
    {packageName: '@google-cloud/storage', feature: 'GcsToolset'},
    () => import('@google-cloud/storage'),
  );
  return new Storage({
    ...config,
    // Copied, so that no client can mutate the shared default.
    scopes: config?.scopes ?? [...GCS_DEFAULT_SCOPE],
    userAgent: GCS_TOOL_USER_AGENT,
    ...(project !== undefined ? {projectId: project} : {}),
  });
}
