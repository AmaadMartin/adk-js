/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';

/**
 * One buffered realtime audio chunk, held on the invocation context until an
 * `AudioCacheManager` flushes it to the artifact service.
 */
export interface RealtimeCacheEntry {
  /**
   * The role that produced this chunk, typically "user" or "model".
   */
  role: string;

  /**
   * The audio chunk. Its `data` field is a base64 string, as everywhere in
   * `@google/genai`.
   */
  data: Blob;

  /**
   * When the chunk was received, in milliseconds since the Unix epoch — the
   * same unit as an adk-js event timestamp. adk-python stores seconds here,
   * because its own events use seconds.
   */
  timestamp: number;
}
