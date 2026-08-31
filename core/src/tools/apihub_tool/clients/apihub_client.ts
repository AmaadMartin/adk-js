/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fetches API specifications from API Hub.
 *
 * Implementations resolve an API Hub resource name to the text of a single
 * OpenAPI specification. A resource name may address an API, a version or a
 * specific spec; an implementation that is given an API or a version picks the
 * first spec of the first version.
 */
export interface BaseAPIHubClient {
  /**
   * Returns the specification text for an API Hub resource.
   *
   * @param resourceName An API Hub resource name, for example
   *     `projects/my-project/locations/us-central1/apis/my-api`.
   * @returns The specification text, in JSON or YAML.
   */
  getSpecContent(resourceName: string): Promise<string>;
}
