/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DocumentData} from '@google-cloud/firestore';
import {Firestore} from '@google-cloud/firestore';
import {
  getLogger,
  type BaseMemoryService,
  type MemoryEntry,
  type SearchMemoryRequest,
  type SearchMemoryResponse,
  type Session,
} from '@google/adk';
import type {Content} from '@google/genai';

import {DEFAULT_STOP_WORDS} from './stop_words.js';

/** The collection that holds memory documents when the caller names none. */
export const DEFAULT_MEMORIES_COLLECTION = 'memories';

/**
 * Writes per batch, matching adk-python.
 *
 * It bounds one commit, so a long session cannot build a request Firestore
 * rejects for its size.
 */
const MAX_BATCH_WRITES = 500;

/** The timestamp a memory entry carries when its stored value is unusable. */
const EPOCH_ISO = new Date(0).toISOString();

/** Options for {@link FirestoreMemoryService}. */
export interface FirestoreMemoryServiceOptions {
  /** An existing Firestore client. A default client is created when omitted. */
  client?: Firestore;
  /**
   * Collection holding memory documents. Defaults to
   * {@link DEFAULT_MEMORIES_COLLECTION}.
   */
  memoriesCollection?: string;
  /**
   * Words ignored when extracting keywords. Defaults to
   * {@link DEFAULT_STOP_WORDS}.
   */
  stopWords?: ReadonlySet<string>;
}

/**
 * A memory service backed by Google Cloud Firestore.
 *
 * It writes one memory document per session event into a top-level collection,
 * indexed by the keywords in that event's text. A search extracts the keywords
 * of the query, runs one `array-contains` lookup per keyword, and returns the
 * de-duplicated union.
 */
export class FirestoreMemoryService implements BaseMemoryService {
  private readonly client: Firestore;
  private readonly memoriesCollection: string;
  private readonly stopWords: ReadonlySet<string>;

  constructor(options: FirestoreMemoryServiceOptions = {}) {
    this.client = options.client ?? new Firestore();
    this.memoriesCollection =
      options.memoriesCollection ?? DEFAULT_MEMORIES_COLLECTION;
    this.stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;
  }

  async addSessionToMemory(session: Session): Promise<void> {
    let batch = this.client.batch();
    let count = 0;

    for (const event of session.events) {
      const content = event.content;
      if (!content) {
        continue;
      }

      const text = joinPartText(content);
      if (!text) {
        continue;
      }

      const keywords = extractKeywords(text, this.stopWords);
      if (keywords.size === 0) {
        continue;
      }

      const docRef = this.client.collection(this.memoriesCollection).doc();
      batch.set(docRef, {
        appName: session.appName,
        userId: session.userId,
        keywords: [...keywords],
        author: event.author,
        content: toStorableContent(content),
        timestamp: event.timestamp,
      });

      count += 1;
      if (count >= MAX_BATCH_WRITES) {
        await batch.commit();
        batch = this.client.batch();
        count = 0;
      }
    }

    if (count > 0) {
      await batch.commit();
    }
  }

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse> {
    const keywords = extractKeywords(request.query, this.stopWords);
    if (keywords.size === 0) {
      return {memories: []};
    }

    const lanes = await Promise.allSettled(
      [...keywords].map((keyword) =>
        this.searchByKeyword(request.appName, request.userId, keyword),
      ),
    );

    const seen = new Set<string>();
    const memories: MemoryEntry[] = [];
    for (const lane of lanes) {
      if (lane.status === 'rejected') {
        getLogger().warn(
          `Memory keyword search partial failure: ${lane.reason}`,
        );
        continue;
      }
      for (const entry of lane.value) {
        const key = JSON.stringify([
          entry.author,
          joinPartText(entry.content),
          entry.timestamp,
        ]);
        if (!seen.has(key)) {
          seen.add(key);
          memories.push(entry);
        }
      }
    }

    return {memories};
  }

  /** Reads every memory document that carries one keyword. */
  private async searchByKeyword(
    appName: string,
    userId: string,
    keyword: string,
  ): Promise<MemoryEntry[]> {
    const snapshot = await this.client
      .collection(this.memoriesCollection)
      .where('appName', '==', appName)
      .where('userId', '==', userId)
      .where('keywords', 'array-contains', keyword)
      .get();

    return toMemoryEntries(snapshot.docs.map((doc) => doc.data()));
  }
}

/**
 * Extracts the searchable keywords of a text.
 *
 * The tokenizer is `[A-Za-z]+`, ported from adk-python. Text made only of
 * digits or of non-Latin script therefore yields no keyword at all.
 */
export function extractKeywords(
  text: string,
  stopWords: ReadonlySet<string>,
): Set<string> {
  const words = text.toLowerCase().match(/[A-Za-z]+/g) ?? [];
  return new Set(words.filter((word) => !stopWords.has(word)));
}

/** Joins the text of every part that carries some. */
function joinPartText(content: Content): string {
  return (content.parts ?? [])
    .map((part) => part.text)
    .filter((text) => !!text)
    .join(' ');
}

/**
 * Drops the `undefined` fields of a content.
 *
 * The Firestore client rejects an `undefined` field value, and adk-python
 * writes the same document through `model_dump(exclude_none=True)`.
 */
function toStorableContent(content: Content): Content {
  return JSON.parse(JSON.stringify(content));
}

/** Reads a memory entry per document, skipping the ones that do not parse. */
function toMemoryEntries(documents: DocumentData[]): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const data of documents) {
    const content: unknown = data['content'];
    if (content === undefined) {
      continue;
    }
    if (!isContent(content)) {
      getLogger().warn(
        'Failed to parse memory entry: content is not an object',
      );
      continue;
    }

    const author: unknown = data['author'];
    entries.push({
      content,
      author: typeof author === 'string' ? author : '',
      timestamp: formatTimestamp(data['timestamp']),
    });
  }
  return entries;
}

/**
 * Narrows a stored field to a {@link Content}.
 *
 * adk-python revalidates the field with `Content.model_validate`. There is no
 * runtime validator here, so this guard rejects the shapes that would
 * otherwise reach the caller as a malformed entry.
 */
function isContent(value: unknown): value is Content {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Formats a stored epoch-milliseconds timestamp as an ISO 8601 string.
 *
 * A value that is missing, is not a number, or falls outside the range a
 * `Date` can hold reads as the epoch. `toISOString()` throws on such a value,
 * which would drop every other entry the same query found.
 */
function formatTimestamp(timestamp: unknown): string {
  const date = new Date(typeof timestamp === 'number' ? timestamp : 0);
  return Number.isNaN(date.getTime()) ? EPOCH_ISO : date.toISOString();
}
