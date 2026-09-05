/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

/**
 * Represents one memory entry retrieved from a memory service.
 *
 * Memory entries are created from session events and surfaced to the agent
 * to provide relevant context from past interactions.
 */
export interface MemoryEntry {
  /**
   * The content of the memory entry, as originally produced during a session.
   */
  content: Content;

  /**
   * The unique identifier of the memory. Services that support it use this as
   * the last component of the created memory's resource name, instead of
   * letting the service generate one.
   */
  id?: string;

  /**
   * Custom metadata associated with the memory. Services that support it store
   * these keys with the memory and return them on retrieval.
   */
  customMetadata?: Record<string, unknown>;

  /**
   * The author of the memory. Common values are `'user'` and `'model'`, but
   * this can also be the name of an agent when the content was produced by a
   * named sub-agent.
   */
  author?: string;

  /**
   * The time when the original content was produced.
   * Forwarded to the LLM as part of the memory context.
   * Preferred format is ISO 8601 (e.g. `'2024-01-15T10:30:00.000Z'`).
   */
  timestamp?: string;
}
