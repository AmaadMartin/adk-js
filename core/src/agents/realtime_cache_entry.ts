/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';

/**
 * One audio chunk held on the invocation before it is flushed to the session
 * and artifact services.
 *
 * Mirrors `google/adk-python` `RealtimeCacheEntry`.
 */
export interface RealtimeCacheEntry {
  /** The role that produced the chunk, typically `'user'` or `'model'`. */
  role: string;

  /** The audio chunk. */
  data: Blob;

  /**
   * When the chunk arrived, in milliseconds since the epoch (adk-python
   * stores epoch seconds; adk-js uses `Date.now()` units throughout).
   */
  timestamp: number;
}
