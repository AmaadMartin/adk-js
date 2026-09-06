/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Configuration for the Eventarc tools. */

import type {EventarcSdkCredentials} from './sdk.js';

/**
 * How long a publish call may run before it is abandoned, in milliseconds.
 *
 * adk-python spells the same 15 seconds as `publish_timeout: float = 15.0`.
 * The unit differs because `google-gax` takes `CallOptions.timeout` in
 * milliseconds.
 */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 15_000;

/** Configuration for the Eventarc tools. */
export interface EventarcToolConfig {
  /** Project id used for telemetry and API calls. */
  projectId?: string;
  /** Publish timeout. Defaults to {@link DEFAULT_PUBLISH_TIMEOUT_MS}. */
  publishTimeoutMs?: number;
}

/**
 * How the Eventarc tools authenticate.
 *
 * Leave it unset to use Application Default Credentials.
 */
export interface EventarcCredentialsConfig {
  /** Inline credential body, as Google's client libraries read it. */
  credentials?: EventarcSdkCredentials;
  /** A service-account key file, read by the SDK. */
  keyFilename?: string;
  /** OAuth scopes. Omit for the SDK's default. */
  scopes?: string[];
}
