/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';

import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js';

import {
  AddEventsToMemoryRequest,
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from './base_memory_service.js';
import {MemoryEntry} from './memory_entry.js';

/** The bucket that holds events added without a session ID. */
const UNKNOWN_SESSION_ID = '__unknown_session_id__';

/** The largest number of memories a single search returns. */
const MAX_SEARCH_RESULTS = 10;

/** Matches text that holds at least one non-ASCII character. */
const NON_ASCII = /[^\p{ASCII}]/u;

/** An event that is known to carry at least one content part. */
type EventWithParts = Event & {content: Content & {parts: Part[]}};

/**
 * An in-memory memory service for prototyping purpose only.
 *
 * Uses keyword matching instead of semantic search. A search returns at most
 * ten memories, the ones sharing the most words with the query.
 */
export class InMemoryMemoryService implements BaseMemoryService {
  /**
   * A map from user key to a map from session ID to events.
   *
   * Both levels are `Map`s rather than object literals. A session ID arrives
   * off the request path and can be exactly `__proto__`, which on an object
   * literal re-parents the map instead of creating an own property. A `Map`
   * also keeps strict insertion order for integer-like keys, which the search
   * ranking relies on to break ties.
   */
  private readonly sessionEvents = new Map<
    string,
    Map<string, EventWithParts[]>
  >();

  async addSessionToMemory(session: Session): Promise<void> {
    const sessions = this.getOrCreateSessions(session.appName, session.userId);
    sessions.set(session.id, session.events.filter(hasContentParts));
  }

  /**
   * Adds an explicit list of events to the memory.
   *
   * The events are appended to the session bucket, never replacing it, and an
   * event whose ID is already in the bucket is skipped. `customMetadata` is
   * accepted for interface compatibility and ignored by this service.
   *
   * @param request The request describing the events to add.
   * @return A promise that resolves when the events are added to the memory.
   */
  async addEventsToMemory(request: AddEventsToMemoryRequest): Promise<void> {
    const sessions = this.getOrCreateSessions(request.appName, request.userId);
    const scopedSessionId = request.sessionId || UNKNOWN_SESSION_ID;
    const events = sessions.get(scopedSessionId) ?? [];
    const existingIds = new Set(events.map((event) => event.id));

    for (const event of request.events.filter(hasContentParts)) {
      if (!existingIds.has(event.id)) {
        events.push(event);
        existingIds.add(event.id);
      }
    }
    sessions.set(scopedSessionId, events);
  }

  async searchMemory(req: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    const wordsInQuery = extractWordsLower(req.query);
    const sessions = this.sessionEvents.get(
      getUserKey(req.appName, req.userId),
    );
    const scoredMemories: Array<{score: number; memory: MemoryEntry}> = [];

    for (const events of sessions?.values() ?? []) {
      for (const event of events) {
        const eventText = event.content.parts
          .map((part) => part.text)
          .filter((text) => !!text)
          .join(' ');
        const wordsInEvent = extractWordsLower(eventText);
        if (!wordsInEvent.size) {
          continue;
        }

        const score = countMatchedWords(wordsInQuery, wordsInEvent, eventText);
        if (score) {
          scoredMemories.push({
            score,
            memory: {
              content: event.content,
              author: event.author,
              timestamp: formatTimestamp(event.timestamp),
            },
          });
        }
      }
    }

    // Almost any two sentences share a word, so returning every event that
    // matches at least one query word returns most of the store, and callers
    // such as the preload memory tool put all of it in the prompt. The
    // comparator reads only the score, and `sort` is stable, so events that
    // match equally keep their insertion order.
    scoredMemories.sort((a, b) => b.score - a.score);
    return {
      memories: scoredMemories
        .slice(0, MAX_SEARCH_RESULTS)
        .map((scored) => scored.memory),
    };
  }

  private getOrCreateSessions(
    appName: string,
    userId: string,
  ): Map<string, EventWithParts[]> {
    const userKey = getUserKey(appName, userId);
    const sessions =
      this.sessionEvents.get(userKey) ?? new Map<string, EventWithParts[]>();
    this.sessionEvents.set(userKey, sessions);
    return sessions;
  }
}

/**
 * Constructs the user key from the app name and user ID.
 *
 * The encoding is unambiguous, so no pair of identifiers can alias another
 * pair and read its memories.
 *
 * @param appName The app name.
 * @param userId The user ID.
 * @return The user key.
 */
function getUserKey(appName: string, userId: string): string {
  return JSON.stringify([appName, userId]);
}

/**
 * Reports whether the event carries at least one content part.
 *
 * @param event The event to inspect.
 * @return Whether the event has content parts.
 */
function hasContentParts(event: Event): event is EventWithParts {
  return (event.content?.parts?.length ?? 0) > 0;
}

/**
 * Extracts the words from the text.
 *
 * The pattern matches Unicode letters, numbers and underscore, the equivalent
 * of Python's `\w`.
 *
 * @param text The text to extract the words from.
 * @return A set of lowercased words.
 */
function extractWordsLower(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) =>
      match[0].toLowerCase(),
    ),
  );
}

/**
 * Counts the distinct query words that the event matches.
 *
 * A non-ASCII query word also matches as a substring of the event text,
 * because scripts such as Japanese and Chinese are not space-delimited and so
 * do not tokenize into the words a user searches for.
 *
 * @param wordsInQuery The lowercased words of the query.
 * @param wordsInEvent The lowercased words of the event text.
 * @param eventText The event text.
 * @return The number of matched query words.
 */
function countMatchedWords(
  wordsInQuery: Set<string>,
  wordsInEvent: Set<string>,
  eventText: string,
): number {
  const eventTextLower = eventText.toLowerCase();
  let matched = 0;
  for (const queryWord of wordsInQuery) {
    if (
      wordsInEvent.has(queryWord) ||
      (NON_ASCII.test(queryWord) && eventTextLower.includes(queryWord))
    ) {
      matched++;
    }
  }
  return matched;
}

/**
 * Formats the timestamp to a string in ISO format.
 *
 * @param timestamp The timestamp to format.
 * @return A string representing the timestamp in ISO format.
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
