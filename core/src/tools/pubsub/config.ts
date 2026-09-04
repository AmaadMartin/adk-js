/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration for the Pub/Sub tools.
 *
 * adk-python declares this model with `extra='forbid'`. TypeScript's
 * excess-property check rejects an unknown field on an object literal at the
 * call site, so there is no runtime validator here. A value widened to
 * `PubSubToolConfig` before it is passed escapes that check.
 */
export interface PubSubToolConfig {
  /**
   * GCP project id to use for the Pub/Sub operations. When unset, the project
   * is inferred from the environment or from the credentials.
   */
  projectId?: string;
}
