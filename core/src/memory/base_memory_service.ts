/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js';

import {MemoryEntry} from './memory_entry.js';

/**
 * Represents the response from a memory search.
 */
export interface SearchMemoryResponse {
  /**
   * A list of memory entries that are related to the search query.
   */
  memories: MemoryEntry[];
}

/**
 * The parameters for `searchMemory`.
 */
export interface SearchMemoryRequest {
  /** The app name associated with the memory to search. */
  appName: string;

  /** The user ID whose memory is being searched. */
  userId: string;

  /**
   * The natural language query used to retrieve relevant memories.
   * Implementations may use keyword matching or semantic search.
   */
  query: string;
}

/**
 * The parameters for `addEventsToMemory`.
 */
export interface AddEventsToMemoryRequest {
  /** The app name associated with the memory to write. */
  appName: string;

  /** The user ID whose memory is being written. */
  userId: string;

  /**
   * The events to add. Treated as an incremental delta, not as the full
   * session.
   */
  events: Event[];

  /** Optional session ID used to partition the memory. */
  sessionId?: string;

  /**
   * Optional, portable metadata for memory generation. Supported keys are
   * defined by each implementation.
   */
  customMetadata?: Record<string, unknown>;
}

/**
 * Base interface for memory services.
 *
 * The service provides functionalities to ingest sessions into memory so that
 * the memory can be used for user queries.
 */
export interface BaseMemoryService {
  /**
   * Adds a session to the memory.
   *
   * @param session The session to add to the memory.
   * @return A promise that resolves when the session is added to the memory.
   */
  addSessionToMemory(session: Session): Promise<void>;

  /**
   * Adds an explicit list of events to the memory.
   *
   * Optional: a service that only supports full-session ingestion omits it,
   * and callers feature-detect before calling.
   *
   * @param request The request describing the events to add.
   * @return A promise that resolves when the events are added to the memory.
   */
  addEventsToMemory?(request: AddEventsToMemoryRequest): Promise<void>;

  /**
   * Searches for sessions that match the query.
   *
   * @param request The request to search memory.
   * @return A promise that resolves to SearchMemoryResponse containing the
   *     matching memories.
   */
  searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse>;
}
