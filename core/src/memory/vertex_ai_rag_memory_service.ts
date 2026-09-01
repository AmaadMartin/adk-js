/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session} from '../sessions/session.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {
  RagApiClient,
  RagContext,
  VertexRagApiClient,
} from '../utils/vertex_rag_api.js';
import {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from './base_memory_service.js';
import {MemoryEntry} from './memory_entry.js';
import {
  buildSourceDisplayName,
  mergeEventLists,
  parseSourceDisplayName,
  parseTranscriptEvents,
  serializeSessionTranscript,
  SourceIdentity,
  TranscriptEvent,
} from './rag_memory_transcript.js';

/** Files requested per listing page. */
const RAG_FILE_PAGE_SIZE = 100;

/**
 * Listing pages one search may walk. The cap keeps the cost of a search
 * independent of how large a shared corpus grows.
 */
const MAX_RAG_FILE_PAGES = 10;

/** Vector distance at or above which a retrieved context is dropped. */
const DEFAULT_VECTOR_DISTANCE_THRESHOLD = 10;

/** Options for {@link VertexAiRagMemoryService}. */
export interface VertexAiRagMemoryServiceOptions {
  /**
   * `projects/{project}/locations/{location}/ragCorpora/{ragCorpusId}`, or a
   * bare `{ragCorpusId}` when the project and the location come from `project`
   * and `location` or from the environment.
   */
  ragCorpus: string;
  /**
   * Number of contexts to retrieve. Sent as `query.ragRetrievalConfig.topK`,
   * because the request-level `VertexRagStore` has no such field.
   */
  similarityTopK?: number;
  /** Only return contexts below this vector distance. Defaults to 10. */
  vectorDistanceThreshold?: number;
  /** Defaults to `process.env.GOOGLE_CLOUD_PROJECT`. */
  project?: string;
  /** Defaults to `process.env.GOOGLE_CLOUD_LOCATION`. */
  location?: string;
  /** Defaults to a REST client for the resolved location. */
  ragApiClient?: RagApiClient;
}

/** The project and location every RAG call is addressed to. */
interface RagEndpoint {
  project: string;
  location: string;
}

/**
 * A {@link BaseMemoryService} backed by a Vertex AI RAG Engine corpus.
 *
 * A finished session is stored as one RAG file holding its transcript, and a
 * search retrieves the chunks of those transcripts that match the query.
 * Mirrors adk-python's `VertexAiRagMemoryService`, so only
 * `addSessionToMemory` and `searchMemory` are supported.
 *
 * @example
 * ```ts
 * const memoryService = new VertexAiRagMemoryService({
 *   ragCorpus: 'projects/my-project/locations/us-central1/ragCorpora/12345',
 *   similarityTopK: 5,
 * });
 * await memoryService.addSessionToMemory(session);
 * ```
 */
export class VertexAiRagMemoryService implements BaseMemoryService {
  private readonly ragCorpus: string;
  private readonly similarityTopK?: number;
  private readonly vectorDistanceThreshold: number;
  private readonly project?: string;
  private readonly location?: string;
  private client?: RagApiClient;

  constructor(options: VertexAiRagMemoryServiceOptions) {
    this.ragCorpus = options.ragCorpus;
    this.similarityTopK = options.similarityTopK;
    this.vectorDistanceThreshold =
      options.vectorDistanceThreshold ?? DEFAULT_VECTOR_DISTANCE_THRESHOLD;

    // A qualified corpus name names the project and the location the corpus
    // actually lives in, so it beats the environment.
    const fromCorpus = endpointFromCorpusName(options.ragCorpus);
    this.project =
      options.project ||
      fromCorpus?.project ||
      process.env['GOOGLE_CLOUD_PROJECT'];
    this.location =
      options.location ||
      fromCorpus?.location ||
      process.env['GOOGLE_CLOUD_LOCATION'];
    this.client = options.ragApiClient;
  }

  /** Stores the session's transcript in the corpus as one RAG file. */
  async addSessionToMemory(session: Session): Promise<void> {
    if (!this.ragCorpus) {
      throw new Error('ragCorpus must be set.');
    }
    return this.apiClient().uploadRagFile({
      ragCorpus: this.corpusName(),
      displayName: buildSourceDisplayName({
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
      }),
      content: serializeSessionTranscript(session),
    });
  }

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse> {
    const endpoint = this.endpoint();
    const ragCorpus = this.corpusName();
    const ragFileIds = await this.tenantRagFileIds(ragCorpus, request);
    if (ragFileIds?.length === 0) {
      return {memories: []};
    }

    const response = await this.apiClient().retrieveContexts({
      parent: `projects/${endpoint.project}/locations/${endpoint.location}`,
      vertexRagStore: {
        ragResources: [{ragCorpus, ragFileIds}],
        vectorDistanceThreshold: this.vectorDistanceThreshold,
      },
      query: {
        text: request.query,
        ragRetrievalConfig:
          this.similarityTopK === undefined
            ? undefined
            : {topK: this.similarityTopK},
      },
    });

    return {
      memories: toMemoryEntries(response.contexts?.contexts ?? [], request),
    };
  }

  /**
   * Returns the ids of the corpus files owned by the requesting app and user,
   * or `undefined` when the corpus could not be listed.
   *
   * `undefined` retrieves over the whole corpus. Narrowing only improves
   * ranking and transfer size, and {@link toMemoryEntries} filters every
   * returned context by tenant anyway. Narrowing to a partial listing would
   * instead hide the caller's own memories.
   */
  private async tenantRagFileIds(
    ragCorpus: string,
    request: SearchMemoryRequest,
  ): Promise<string[] | undefined> {
    if (!ragCorpus) {
      return undefined;
    }
    try {
      return await listTenantRagFileIds(this.apiClient(), ragCorpus, request);
    } catch (e: unknown) {
      logger.warn(
        'Listing the corpus failed, so retrieval is not scoped to the ' +
          `requesting app and user: ${formatError(e)}`,
      );
      return undefined;
    }
  }

  /**
   * Returns the corpus resource name. A bare corpus id is qualified with the
   * resolved project and location, which every RAG call needs in the path.
   */
  private corpusName(): string {
    if (!this.ragCorpus || this.ragCorpus.startsWith('projects/')) {
      return this.ragCorpus;
    }
    const endpoint = this.endpoint();
    return (
      `projects/${endpoint.project}/locations/${endpoint.location}` +
      `/ragCorpora/${this.ragCorpus}`
    );
  }

  /**
   * Returns the project and the location, which adk-python resolves at call
   * time rather than at construction.
   */
  private endpoint(): RagEndpoint {
    if (!this.project || !this.location) {
      throw new Error(
        'VertexAiRagMemoryService needs a project and a location. Pass ' +
          'project and location, set GOOGLE_CLOUD_PROJECT and ' +
          'GOOGLE_CLOUD_LOCATION, or give ragCorpus as ' +
          'projects/{project}/locations/{location}/ragCorpora/{ragCorpusId}.',
      );
    }
    return {project: this.project, location: this.location};
  }

  private apiClient(): RagApiClient {
    return (this.client ??= new VertexRagApiClient({
      location: this.endpoint().location,
    }));
  }
}

/** Reads the project and the location out of a corpus resource name. */
function endpointFromCorpusName(ragCorpus: string): RagEndpoint | undefined {
  const segments = ragCorpus.split('/');
  if (
    segments.length < 4 ||
    segments[0] !== 'projects' ||
    segments[2] !== 'locations'
  ) {
    return undefined;
  }
  return {project: segments[1], location: segments[3]};
}

/** Walks the corpus listing and collects the requesting tenant's file ids. */
async function listTenantRagFileIds(
  client: RagApiClient,
  ragCorpus: string,
  request: SearchMemoryRequest,
): Promise<string[] | undefined> {
  const ragFileIds: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_RAG_FILE_PAGES; page++) {
    const response = await client.listRagFiles({
      ragCorpus,
      pageSize: RAG_FILE_PAGE_SIZE,
      pageToken,
    });
    for (const ragFile of response.ragFiles ?? []) {
      if (ragFile.name && tenantSource(ragFile.displayName, request)) {
        // A listing reports the full resource name; ragFileIds takes the id.
        ragFileIds.push(ragFile.name.slice(ragFile.name.lastIndexOf('/') + 1));
      }
    }
    pageToken = response.nextPageToken;
    if (!pageToken) {
      return ragFileIds;
    }
  }

  logger.warn(
    `Listing ${ragCorpus} did not finish within ${MAX_RAG_FILE_PAGES} pages, ` +
      'so retrieval is not scoped to the requesting app and user.',
  );
  return undefined;
}

/**
 * Returns the session behind a display name when it belongs to the requesting
 * app and user, and `undefined` otherwise.
 *
 * This is the tenant boundary. It runs on every retrieved context, including
 * the contexts of a retrieval that could not be narrowed beforehand.
 */
function tenantSource(
  displayName: string | undefined,
  request: SearchMemoryRequest,
): SourceIdentity | undefined {
  if (typeof displayName !== 'string') {
    return undefined;
  }
  const source = parseSourceDisplayName(displayName);
  if (
    !source ||
    source.appName !== request.appName ||
    source.userId !== request.userId
  ) {
    return undefined;
  }
  return source;
}

/**
 * Rebuilds the retrieved chunks into the requesting tenant's memories,
 * grouped by session in the order the corpus returned them.
 */
function toMemoryEntries(
  contexts: RagContext[],
  request: SearchMemoryRequest,
): MemoryEntry[] {
  const eventListsBySession = new Map<string, TranscriptEvent[][]>();
  for (const context of contexts) {
    const source = tenantSource(context.sourceDisplayName, request);
    if (!source) {
      continue;
    }
    const eventLists = eventListsBySession.get(source.sessionId) ?? [];
    eventLists.push(parseTranscriptEvents(context.text ?? ''));
    eventListsBySession.set(source.sessionId, eventLists);
  }

  const memories: MemoryEntry[] = [];
  for (const eventLists of eventListsBySession.values()) {
    for (const events of mergeEventLists(eventLists)) {
      const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
      for (const event of sorted) {
        memories.push({
          author: event.author,
          content: {parts: [{text: event.text}]},
          timestamp: new Date(event.timestamp).toISOString(),
        });
      }
    }
  }
  return memories;
}
