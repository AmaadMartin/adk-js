/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, HttpOptions} from '@google/genai';

/**
 * Reads the http options a client was constructed with.
 *
 * `GoogleGenAI` exposes no accessor for them, so the reach into its internals
 * lives here rather than at every assertion.
 */
export function httpOptionsOf(client: GoogleGenAI): HttpOptions {
  return client['apiClient']['clientOptions']['httpOptions'] as HttpOptions;
}
