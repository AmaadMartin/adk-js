/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credentials used to build the Pub/Sub clients.
 *
 * Every field is optional: when nothing is supplied the clients fall back to
 * Application Default Credentials, which is the expected setup on GCP. Supply
 * `projectId` to pin the client to a specific project, and supply both
 * `clientEmail` and `privateKey` to authenticate with a service account key
 * instead of ADC.
 */
export interface PubSubCredentialsConfig {
  /**
   * The Google Cloud project ID. Defaults to the project discovered by
   * Application Default Credentials.
   */
  projectId?: string;

  /**
   * Service account email. Must be supplied together with `privateKey`.
   */
  clientEmail?: string;

  /**
   * Service account private key. Must be supplied together with `clientEmail`.
   */
  privateKey?: string;
}
