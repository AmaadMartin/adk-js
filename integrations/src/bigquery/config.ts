/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings shared by every BigQuery tool (experimental).
 *
 * @experimental Subject to change; not recommended for production use.
 */
export interface BigQueryToolConfig {
  /**
   * BigQuery location for the data and the compute. When it is unset, BigQuery
   * derives the location from the data the request references. For the
   * supported locations, see
   * https://cloud.google.com/bigquery/docs/locations.
   */
  location?: string;
  /**
   * Name of the application that uses the BigQuery tools. It is appended to
   * the user agent of every BigQuery API call.
   *
   * This field serves usage discovery and tracking only. Never base a
   * security-sensitive decision on it.
   */
  applicationName?: string;
}
