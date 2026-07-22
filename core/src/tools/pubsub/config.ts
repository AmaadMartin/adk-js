/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration for Pub/Sub tools.
 */
export interface PubSubToolConfig {
  /**
   * The Google Cloud project ID.
   */
  projectId?: string;
}

/**
 * Configuration for Pub/Sub credentials.
 */
export interface PubSubCredentialsConfig {
  /**
   * Application Default Credentials are used by default.
   * You can override these by specifying configurations here,
   * though typical usage defers to ADC.
   */
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
}
