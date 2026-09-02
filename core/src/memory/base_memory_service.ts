/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotImplementedError} from '../errors/not_implemented_error.js';
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
   * Optional, portable metadata for the write. Supported keys are defined by
   * each implementation.
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
   * Adds explicit memory items to the memory.
   *
   * Optional: a service that only generates memory from events omits the
   * member, so a caller narrows it before calling.
   *
   * @param request The request describing the memory items to write.
   * @return A promise that resolves when the memory items are written.
   */
  addMemory?(request: AddMemoryRequest): Promise<void>;

  /**
   * Searches for sessions that match the query.
   *
   * @param request The request to search memory.
   * @return A promise that resolves to SearchMemoryResponse containing the
   *     matching memories.
   */
  searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse>;
}

/**
 * Adds an explicit list of events to the memory of any memory service.
 *
 * A caller can always call it, whichever service it holds. The call rejects
 * when the service omits the optional member, so an unsupported write reports
 * itself instead of disappearing.
 *
 * @param service The memory service to write to.
 * @param request The request describing the events to add.
 * @return A promise that resolves when the events are added to the memory.
 * @throws {NotImplementedError} When the service ingests whole sessions only.
 *     Call `addSessionToMemory(session)` on it instead.
 */
export async function addEventsToMemory(
  service: BaseMemoryService,
  request: AddEventsToMemoryRequest,
): Promise<void> {
  if (!service.addEventsToMemory) {
    throw new NotImplementedError(
      'This memory service does not support adding event deltas. ' +
        'Call addSessionToMemory(session) to ingest the full session.',
    );
  }
  return service.addEventsToMemory(request);
}

/**
 * Adds explicit memory items to any memory service.
 *
 * A caller can always call it, whichever service it holds. The call rejects
 * when the service omits the optional member, so an unsupported write reports
 * itself instead of disappearing.
 *
 * @param service The memory service to write to.
 * @param request The request describing the memory items to write.
 * @return A promise that resolves when the memory items are written.
 * @throws {NotImplementedError} When the service generates memory from events
 *     only. Call `addEventsToMemory(...)` or `addSessionToMemory(session)` on
 *     it instead.
 */
export async function addMemory(
  service: BaseMemoryService,
  request: AddMemoryRequest,
): Promise<void> {
  if (!service.addMemory) {
    throw new NotImplementedError(
      'This memory service does not support direct memory writes. ' +
        'Call addEventsToMemory(...) or addSessionToMemory(session) instead.',
    );
  }
  return service.addMemory(request);
}
