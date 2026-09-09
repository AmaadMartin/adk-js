/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';

/**
 * A single chunk of live audio held in memory until it is flushed to the
 * artifact service.
 */
export interface RealtimeCacheEntry {
  /** The role that produced this audio, either `user` or `model`. */
  role: string;

  /** The audio chunk. Its `data` is base64-encoded, as `@google/genai` sends it. */
  data: Blob;

  /** When the chunk arrived, in epoch milliseconds. */
  timestamp: number;
}
