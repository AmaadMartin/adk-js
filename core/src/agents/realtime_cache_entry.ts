/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';

/**
 * A cached realtime audio chunk, held on the invocation before it is flushed
 * to the session and artifact services.
 */
export interface RealtimeCacheEntry {
  /**
   * The role that created this audio data, typically "user" or "model".
   */
  role: string;

  /**
   * The audio data chunk.
   */
  data: Blob;

  /**
   * When the chunk was received, in seconds since the Unix epoch — the same
   * unit as adk-python's `time.time()`, so a value written by either SDK means
   * the same thing. Produce it as `Date.now() / 1000`.
   */
  timestamp: number;
}
