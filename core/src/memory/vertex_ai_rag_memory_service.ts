/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {Client} from '@google-cloud/vertexai';
import {
  Content,
  VertexRagStore,
  VertexRagStoreRagResource,
} from '@google/genai';

import {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';

import {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from './base_memory_service.js';
import {MemoryEntry} from './memory_entry.js';

/**
 * Prefix that marks a source display name as using the collision-safe,
 * base64url-encoded encoding produced by {@link buildSourceDisplayName}.
 */
const SOURCE_DISPLAY_NAME_PREFIX = 'adk-memory-v1.';

/** Default vector-distance threshold when the caller does not provide one. */
const DEFAULT_VECTOR_DISTANCE_THRESHOLD = 10;

/**
 * A single RAG context returned by a retrieval query.
 *
 * The installed `@google-cloud/vertexai` (1.12.0) does not yet expose a RAG
 * binding, so the retrieval surface is described by these local interfaces.
 * They mirror the Python reference contract; unit tests inject a mock that
 * satisfies {@link RagClient}.
 */
interface RagContext {
  sourceDisplayName?: string;
  text?: string;
}

/** Response shape returned by `rag.retrieveContexts`. */
interface RagRetrieveContextsResponse {
  contexts?: {contexts?: RagContext[]};
}

/** Parameters accepted by `rag.uploadFile`. */
interface RagUploadFileParams {
  corpusName?: string;
  path: string;
  displayName: string;
}

/** Parameters accepted by `rag.retrieveContexts`. */
interface RagRetrieveContextsParams {
  vertexRagStore: VertexRagStore;
  query: {text: string; similarityTopK?: number};
}

/**
 * Minimal RAG client surface consumed by {@link VertexAiRagMemoryService}.
 *
 * A real `@google-cloud/vertexai` `Client` is constructed when none is
 * injected and adapted to this surface, so the service builds and typechecks
 * even before the SDK ships an official `rag` binding.
 */
interface RagClient {
  rag: {
    uploadFile(params: RagUploadFileParams): Promise<unknown>;
    retrieveContexts(
      params: RagRetrieveContextsParams,
    ): Promise<RagRetrieveContextsResponse>;
  };
}

/** Parsed `(appName, userId, sessionId)` triple from a source display name. */
type ParsedDisplayName = [string, string, string];

/** The JSON schema of a single serialized event line stored on the corpus. */
interface SerializedEvent {
  author?: string;
  timestamp?: number;
  text?: string;
}

/**
 * A minimal event reconstructed from a stored context line. Only the fields
 * needed to merge, sort, and surface memory entries are retained.
 */
interface StoredEvent {
  author?: string;
  timestamp: number;
  content: Content;
}

/** Encodes a single display-name part as unpadded base64url. */
function encodeSourceDisplayNamePart(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

/**
 * Decodes a single unpadded base64url display-name part.
 *
 * Node's base64url decoder is lenient (it silently drops invalid characters),
 * so the decoded bytes are re-encoded and compared against the input to reject
 * corrupt or non-canonical segments. This mirrors Python's `validate=True` and
 * guarantees the encoding is round-trippable.
 *
 * @throws if `value` is not canonical base64url.
 */
function decodeSourceDisplayNamePart(value: string): string {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error(`Invalid base64url segment: ${value}`);
  }
  return decoded.toString('utf-8');
}

/**
 * Builds a collision-safe source display name encoding the session identity.
 *
 * Each part is base64url-encoded so that dots in `appName`, `userId` or
 * `sessionId` cannot create ambiguity when the name is later parsed.
 */
function buildSourceDisplayName(
  appName: string,
  userId: string,
  sessionId: string,
): string {
  return (
    SOURCE_DISPLAY_NAME_PREFIX +
    [
      encodeSourceDisplayNamePart(appName),
      encodeSourceDisplayNamePart(userId),
      encodeSourceDisplayNamePart(sessionId),
    ].join('.')
  );
}

/**
 * Parses a source display name back into `(appName, userId, sessionId)`.
 *
 * Prefixed names are base64url-decoded and validated. Legacy (unprefixed) names
 * are only accepted in their exact three-part dotted form; names with any other
 * number of parts are rejected so that dotted IDs cannot masquerade as another
 * session's memory.
 *
 * @returns the parsed triple, or `undefined` if the name is malformed.
 */
function parseSourceDisplayName(
  sourceDisplayName: string,
): ParsedDisplayName | undefined {
  if (sourceDisplayName.startsWith(SOURCE_DISPLAY_NAME_PREFIX)) {
    const parts = sourceDisplayName
      .slice(SOURCE_DISPLAY_NAME_PREFIX.length)
      .split('.');
    if (parts.length !== 3) {
      return undefined;
    }
    try {
      return [
        decodeSourceDisplayNamePart(parts[0]),
        decodeSourceDisplayNamePart(parts[1]),
        decodeSourceDisplayNamePart(parts[2]),
      ];
    } catch {
      return undefined;
    }
  }

  // Legacy display names were dot-delimited. Only the exact three-part form is
  // unambiguous, so dotted app/user/session IDs are intentionally rejected.
  const parts = sourceDisplayName.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * Merges event lists that share at least one timestamp.
 *
 * Contexts retrieved for the same session may overlap; lists that share any
 * event timestamp are unioned together (deduplicating on timestamp) while
 * disjoint lists are kept separate.
 */
function mergeEventLists(eventLists: StoredEvent[][]): StoredEvent[][] {
  const merged: StoredEvent[][] = [];
  let remaining = [...eventLists];

  while (remaining.length > 0) {
    const [current, ...rest] = remaining;
    remaining = rest;
    const currentTimestamps = new Set(current.map((event) => event.timestamp));
    let mergeFound = true;

    // Keep merging until no new overlap is found.
    while (mergeFound) {
      mergeFound = false;
      const stillRemaining: StoredEvent[][] = [];
      for (const other of remaining) {
        const overlaps = other.some((event) =>
          currentTimestamps.has(event.timestamp),
        );
        if (overlaps) {
          const newEvents = other.filter(
            (event) => !currentTimestamps.has(event.timestamp),
          );
          current.push(...newEvents);
          for (const event of newEvents) {
            currentTimestamps.add(event.timestamp);
          }
          mergeFound = true;
        } else {
          stillRemaining.push(other);
        }
      }
      remaining = stillRemaining;
    }
    merged.push(current);
  }
  return merged;
}

/**
 * Options for constructing a {@link VertexAiRagMemoryService}.
 */
export interface VertexAiRagMemoryServiceOptions {
  /**
   * The RAG corpus name. Either a fully-qualified
   * `projects/{project}/locations/{location}/ragCorpora/{id}` resource name or
   * a bare `{id}`.
   */
  ragCorpus?: string;

  /** The number of contexts to retrieve. Forwarded to the retrieval query. */
  similarityTopK?: number;

  /**
   * Only return contexts with a vector distance smaller than this threshold.
   * Defaults to 10.
   */
  vectorDistanceThreshold?: number;

  /**
   * The GCP project. Defaults to the `GOOGLE_CLOUD_PROJECT` environment
   * variable, then to the project parsed from a fully-qualified `ragCorpus`.
   */
  projectId?: string;

  /**
   * The GCP location. Defaults to the `GOOGLE_CLOUD_LOCATION` environment
   * variable, then to the location parsed from a fully-qualified `ragCorpus`.
   */
  location?: string;

  /** Injectable client for tests; when omitted a real `Client` is constructed. */
  client?: Client;
}

/**
 * A {@link BaseMemoryService} backed by a Vertex AI RAG corpus.
 *
 * Sessions are serialized to a temporary file (one JSON object per
 * text-bearing event) and uploaded to the corpus, tagged with a collision-safe
 * display name that encodes the `(appName, userId, sessionId)` identity.
 * Searches run a semantic retrieval query, filter results back to the
 * requesting user, reconstruct events, and return them as memory entries.
 *
 * @example
 * ```ts
 * import {VertexAiRagMemoryService} from '@google/adk';
 *
 * const memory = new VertexAiRagMemoryService({
 *   ragCorpus: 'projects/my-project/locations/us-central1/ragCorpora/my-corpus',
 *   similarityTopK: 5,
 *   vectorDistanceThreshold: 10,
 * });
 *
 * await memory.addSessionToMemory(session);
 * const {memories} = await memory.searchMemory({
 *   appName: 'my-app',
 *   userId: 'alice',
 *   query: 'what is the user\'s favorite color?',
 * });
 * ```
 */
export class VertexAiRagMemoryService implements BaseMemoryService {
  private readonly ragResources: VertexRagStoreRagResource[];
  private readonly vertexRagStore: VertexRagStore;
  private readonly client: RagClient;

  constructor(options: VertexAiRagMemoryServiceOptions = {}) {
    let projectId = options.projectId ?? process.env['GOOGLE_CLOUD_PROJECT'];
    let location = options.location ?? process.env['GOOGLE_CLOUD_LOCATION'];

    // Fallback: derive the project/location from a fully-qualified corpus name
    // when they are not otherwise set.
    if (
      (!projectId || !location) &&
      options.ragCorpus?.startsWith('projects/')
    ) {
      // `parts[0]` is guaranteed to be 'projects' by the `startsWith` guard.
      const parts = options.ragCorpus.split('/');
      if (parts.length >= 4 && parts[2] === 'locations') {
        projectId = projectId ?? parts[1];
        location = location ?? parts[3];
      }
    }

    this.ragResources = options.ragCorpus
      ? [{ragCorpus: options.ragCorpus}]
      : [];
    this.vertexRagStore = {
      ragResources: this.ragResources,
      similarityTopK: options.similarityTopK,
      vectorDistanceThreshold:
        options.vectorDistanceThreshold ?? DEFAULT_VECTOR_DISTANCE_THRESHOLD,
    };

    this.client = (options.client ??
      new Client({project: projectId, location})) as unknown as RagClient;
  }

  async addSessionToMemory(session: Session): Promise<void> {
    if (this.ragResources.length === 0) {
      throw new Error('Rag resources must be set.');
    }

    const outputLines: string[] = [];
    for (const event of session.events) {
      if (!event.content?.parts) {
        continue;
      }
      const textParts: string[] = [];
      for (const part of event.content.parts) {
        if (part.text) {
          textParts.push(part.text.replace(/\n/g, ' '));
        }
      }
      if (textParts.length > 0) {
        outputLines.push(
          JSON.stringify({
            author: event.author,
            timestamp: event.timestamp,
            text: textParts.join('.'),
          }),
        );
      }
    }

    const tempFilePath = path.join(
      os.tmpdir(),
      `adk-rag-memory-${randomUUID()}.txt`,
    );
    await fs.writeFile(tempFilePath, outputLines.join('\n'), 'utf-8');

    const displayName = buildSourceDisplayName(
      session.appName,
      session.userId,
      session.id,
    );

    // Cleanup runs even if an upload throws, unlike the Python reference which
    // removes the temp file only on success.
    try {
      for (const ragResource of this.ragResources) {
        await this.client.rag.uploadFile({
          corpusName: ragResource.ragCorpus,
          path: tempFilePath,
          displayName,
        });
      }
    } finally {
      await fs.unlink(tempFilePath);
    }
  }

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse> {
    const response = await this.client.rag.retrieveContexts({
      vertexRagStore: this.vertexRagStore,
      query: {
        text: request.query,
        similarityTopK: this.vertexRagStore.similarityTopK,
      },
    });

    logger.debug('Search memory response received.');

    // Insertion-ordered so returned memories preserve corpus ordering.
    const sessionEventsMap = new Map<string, StoredEvent[][]>();
    for (const context of response.contexts?.contexts ?? []) {
      const sourceDisplayName = context.sourceDisplayName;
      if (typeof sourceDisplayName !== 'string') {
        continue;
      }
      const sessionInfo = parseSourceDisplayName(sourceDisplayName);
      if (!sessionInfo) {
        continue;
      }
      const [sourceAppName, sourceUserId, sessionId] = sessionInfo;
      if (
        sourceAppName !== request.appName ||
        sourceUserId !== request.userId
      ) {
        continue;
      }

      const events = parseEventsFromContextText(context.text);
      const existing = sessionEventsMap.get(sessionId);
      if (existing) {
        existing.push(events);
      } else {
        sessionEventsMap.set(sessionId, [events]);
      }
    }

    const memories: MemoryEntry[] = [];
    for (const eventLists of sessionEventsMap.values()) {
      for (const events of mergeEventLists(eventLists)) {
        const sortedEvents = [...events].sort(
          (a, b) => a.timestamp - b.timestamp,
        );
        for (const event of sortedEvents) {
          memories.push({
            author: event.author,
            content: event.content,
            timestamp: new Date(event.timestamp).toISOString(),
          });
        }
      }
    }

    return {memories};
  }
}

/**
 * Reconstructs events from a context's stored text, one JSON object per line.
 * Blank and non-JSON lines are skipped.
 */
function parseEventsFromContextText(text?: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  if (!text) {
    return events;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let eventData: SerializedEvent;
    try {
      eventData = JSON.parse(line) as SerializedEvent;
    } catch {
      continue;
    }
    events.push({
      author: eventData.author ?? '',
      timestamp: eventData.timestamp ?? 0,
      content: {parts: [{text: eventData.text ?? ''}]},
    });
  }
  return events;
}
