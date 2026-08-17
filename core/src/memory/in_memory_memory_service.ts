/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js';

import {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from './base_memory_service.js';
import {MemoryEntry} from './memory_entry.js';

/**
 * The maximum number of memories a search returns.
 */
const MAX_SEARCH_RESULTS = 10;

/**
 * An in-memory memory service for prototyping purpose only.
 *
 * Uses keyword matching instead of semantic search. A search returns at most
 * ten memories, the ones sharing the most words with the query.
 *
 * Every map below is keyed by untrusted input — `appName`, `userId` and
 * `sessionId` all arrive straight off the request path on a dev server — so
 * each is created with `Object.create(null)`. On an ordinary `{}` literal a
 * key of `__proto__` resolves to the inherited `__proto__` accessor instead of
 * creating an own property, so nested assignment pollutes every object in the
 * process.
 */
export class InMemoryMemoryService implements BaseMemoryService {
  /**
   * A map from app name to a map from user ID to a map from session ID to
   * events.
   */
  private readonly sessionEvents: Record<
    string,
    Record<string, Record<string, Event[]>>
  > = Object.create(null);

  async addSessionToMemory(session: Session): Promise<void> {
    const {appName, userId} = session;
    if (!this.sessionEvents[appName]) {
      this.sessionEvents[appName] = Object.create(null);
    }
    if (!this.sessionEvents[appName][userId]) {
      this.sessionEvents[appName][userId] = Object.create(null);
    }
    this.sessionEvents[appName][userId][session.id] = session.events.filter(
      (event) => (event.content?.parts?.length ?? 0) > 0,
    );
  }

  async searchMemory(req: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    const userSessions = this.sessionEvents[req.appName]?.[req.userId];
    if (!userSessions) {
      return Promise.resolve({memories: []});
    }

    const wordsInQuery = [...extractWordsLower(req.query)];
    // A non-ASCII query word also matches as a substring, because scripts such
    // as Japanese have no word delimiters and tokenize to one run. Only such a
    // word reads the lowercased event text, so only then is it built.
    const substringWords = new Set(
      wordsInQuery.filter((word) => !isAscii(word)),
    );
    const scoredMemories: Array<{matchedWords: number; memory: MemoryEntry}> =
      [];

    for (const sessionEvents of Object.values(userSessions)) {
      for (const event of sessionEvents) {
        if (!event.content?.parts?.length) {
          continue;
        }

        const joinedText = event.content.parts
          .map((part) => part.text)
          .filter((text) => !!text)
          .join(' ');
        const wordsInEvent = extractWordsLower(joinedText);
        if (!wordsInEvent.size) {
          continue;
        }

        const eventTextLower = substringWords.size
          ? joinedText.toLowerCase()
          : '';
        const matchedWords = wordsInQuery.filter(
          (word) =>
            wordsInEvent.has(word) ||
            (substringWords.has(word) && eventTextLower.includes(word)),
        ).length;
        if (matchedWords) {
          scoredMemories.push({
            matchedWords,
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
    // such as `PreloadMemoryTool` put all of it in the prompt. Keep the events
    // matching the most query words. The sort key reads only the count, so the
    // stable sort leaves events matching equally in insertion order.
    scoredMemories.sort((a, b) => b.matchedWords - a.matchedWords);
    return {
      memories: scoredMemories
        .slice(0, MAX_SEARCH_RESULTS)
        .map((scored) => scored.memory),
    };
  }
}

/**
 * Extracts the words from the text.
 *
 * A word is a run of Unicode letters, digits and underscores.
 *
 * @param text The text to extract the words from.
 * @return A set of lowercase words.
 */
function extractWordsLower(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) =>
      match[0].toLowerCase(),
    ),
  );
}

/**
 * Reports whether the text holds only ASCII characters.
 *
 * @param text The text to test.
 * @return True when every character is ASCII.
 */
function isAscii(text: string): boolean {
  return /^\p{ASCII}*$/u.test(text);
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
