/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient} from 'google-auth-library';

/**
 * Default publish timeout in milliseconds.
 *
 * Matches the 15 second default of the Python `EventarcToolConfig`.
 */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 15_000;

/** OAuth scope requested when the credentials config does not declare any. */
export const CLOUD_PLATFORM_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform';

/** Configuration for the Eventarc tools. */
export interface EventarcToolConfig {
  /** Project ID used for telemetry and API calls. */
  projectId?: string;

  /**
   * Timeout in milliseconds for publishing a message. Defaults to
   * {@link DEFAULT_PUBLISH_TIMEOUT_MS}.
   */
  publishTimeoutMs?: number;
}

/** Configuration for the Google Cloud credentials used to publish. */
export interface EventarcCredentialsConfig {
  /**
   * Pre-constructed auth client. When omitted, Application Default Credentials
   * are resolved by the publisher client.
   */
  authClient?: AuthClient;

  /** OAuth scopes. Defaults to `[CLOUD_PLATFORM_SCOPE]`. */
  scopes?: string[];
}

/** Returns the publish timeout in milliseconds, applying the default. */
export function resolvePublishTimeoutMs(config?: EventarcToolConfig): number {
  return config?.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
}

/** Returns the OAuth scopes to request, applying the default. */
export function resolveScopes(config?: EventarcCredentialsConfig): string[] {
  return config?.scopes ?? [CLOUD_PLATFORM_SCOPE];
}
