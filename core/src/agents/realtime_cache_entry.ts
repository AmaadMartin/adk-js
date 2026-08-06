/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';

/**
 * Stores a single live-audio chunk cached before it is flushed to an artifact.
 */
export interface RealtimeCacheEntry {
  /**
   * The role that produced this audio: `'user'` for input, `'model'` for
   * output.
   */
  role: string;

  /**
   * The audio data chunk. `data.data` is a base64-encoded string.
   */
  data: Blob;

  /**
   * Epoch-milliseconds timestamp of when the chunk was cached.
   */
  timestamp: number;
}
