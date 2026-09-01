/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js';

import {MemoryEntry} from './memory_entry.js';

/** Reported when a memory service cannot ingest an event delta. */
export const EVENT_DELTAS_UNSUPPORTED_MESSAGE =
  'This memory service does not support adding event deltas. ' +
  'Call addSessionToMemory(session) to ingest the full session.';

/** Reported when a memory service cannot take a direct memory write. */
export const DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE =
  'This memory service does not support direct memory writes. ' +
  'Call addEventsToMemory(...) or addSessionToMemory(session) instead.';

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
 * Creates a {@link SearchMemoryResponse}, defaulting `memories` to an empty
 * list.
 *
 * A response built without matches carries an empty array, never `undefined`.
 */
export function createSearchMemoryResponse(
  init: Partial<SearchMemoryResponse> = {},
): SearchMemoryResponse {
  return {memories: init.memories ?? []};
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
   * The events to add. An implementation treats them as an incremental update
   * (delta) and must not assume they are the full session.
   */
  events: Event[];

  /**
   * The session ID used to scope or partition the memory. An implementation
   * may ignore it when it does not partition memory that way.
   */
  sessionId?: string;

  /**
   * Portable metadata for memory generation, such as a TTL. Supported keys are
   * implementation-defined. Prefer it for service-specific fields that may
   * later become first-class parameters.
   */
  customMetadata?: Record<string, unknown>;
}

/**
 * The parameters for `addMemory`.
 */
export interface AddMemoryRequest {
  /** The app name associated with the memory to write. */
  appName: string;

  /** The user ID whose memory is being written. */
  userId: string;

  /** The explicit memory items to write. */
  memories: MemoryEntry[];

  /**
   * Portable metadata for memory writes. Supported keys are
   * implementation-defined.
   */
  customMetadata?: Record<string, unknown>;
}

/**
 * Base class for memory services.
 *
 * The service provides functionalities to ingest sessions into memory so that
 * the memory can be used for user queries.
 */
export abstract class BaseMemoryService {
  /**
   * Adds a session to the memory.
   *
   * @param session The session to add to the memory.
   * @return A promise that resolves when the session is added to the memory.
   */
  abstract addSessionToMemory(session: Session): Promise<void>;

  /**
   * Adds an explicit list of events to the memory.
   *
   * Use it to persist a subset of events, such as the latest turn, instead of
   * re-ingesting the full session.
   *
   * A service that only ingests whole sessions inherits this default, which
   * rejects instead of dropping the write.
   *
   * @param _request The request describing the events to add.
   * @return A promise that resolves when the events are added to the memory.
   */
  async addEventsToMemory(_request: AddEventsToMemoryRequest): Promise<void> {
    throw new Error(EVENT_DELTAS_UNSUPPORTED_MESSAGE);
  }

  /**
   * Adds explicit memory items directly to the memory.
   *
   * Use it with a service that supports direct writes in addition to
   * event-based memory generation.
   *
   * A service without direct writes inherits this default, which rejects
   * instead of dropping the write.
   *
   * @param _request The request describing the memories to add.
   * @return A promise that resolves when the memories are added.
   */
  async addMemory(_request: AddMemoryRequest): Promise<void> {
    throw new Error(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE);
  }

  /**
   * Searches for sessions that match the query.
   *
   * @param request The request to search memory.
   * @return A promise that resolves to SearchMemoryResponse containing the
   *     matching memories.
   */
  abstract searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse>;
}
