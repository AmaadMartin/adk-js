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
  /** The app name the memory is scoped to. */
  appName: string;

  /** The user ID the memory is scoped to. */
  userId: string;

  /**
   * The events to add. An incremental update: implementations must not treat
   * this as the full session.
   */
  events: Event[];

  /** Optional session ID used to scope or partition the memory. */
  sessionId?: string;

  /**
   * Optional, portable metadata for memory generation. Supported keys are
   * defined by each memory service.
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
   * Intended for callers that want to persist only a subset of events (e.g.
   * the latest turn) rather than re-ingesting the full session: `events` is an
   * incremental update and implementations must not assume it is the whole
   * session. An implementation may ignore `sessionId` if it does not partition
   * memory that way.
   *
   * Optional: a service that can only ingest whole sessions opts out by not
   * implementing it, mirroring the `NotImplementedError` default in
   * adk-python's `BaseMemoryService.add_events_to_memory`.
   *
   * @param request The request to add events to the memory.
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

/** The error message reported when a service cannot ingest an event delta. */
export const EVENT_DELTAS_UNSUPPORTED_MESSAGE =
  'This memory service does not support adding event deltas. ' +
  'Call addSessionToMemory(session) to ingest the full session.';

/**
 * Adds an event delta to `service`, rejecting when the service does not accept
 * deltas.
 *
 * `addEventsToMemory` is optional on {@link BaseMemoryService}, so calling it
 * through `service.addEventsToMemory?.(...)` turns a service's opt-out into a
 * silent no-op and the write is lost. Callers that need the write to happen go
 * through this instead.
 *
 * @param service The memory service to write to.
 * @param request The request to add events to the memory.
 * @return A promise that resolves when the events are added to the memory.
 */
export async function addEventsToMemory(
  service: BaseMemoryService,
  request: AddEventsToMemoryRequest,
): Promise<void> {
  if (!service.addEventsToMemory) {
    throw new Error(EVENT_DELTAS_UNSUPPORTED_MESSAGE);
  }
  await service.addEventsToMemory(request);
}
