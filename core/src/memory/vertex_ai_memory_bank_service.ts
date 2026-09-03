/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {Memories} from '@google-cloud/vertexai/build/src/genai/memories.js';
import {
  AgentEngineMemoryConfig,
  GenerateAgentEngineMemoriesConfig,
  GenerateMemoriesRequestDirectContentsSourceEvent,
  IngestEventsRequestParameters,
  IngestionDirectContentsSourceEvent,
  MemoryGenerationTriggerConfig,
  MemoryMetadataValue,
  MemoryProfile,
} from '@google-cloud/vertexai/build/src/genai/types.js';
import {Content, createUserContent} from '@google/genai';
import {ApiClient} from '@google/genai/vertex_internal';
import {GoogleAuthOptions} from 'google-auth-library';
import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import {
  createExpressModeApiClient,
  createVertexApiClient,
  getExpressModeApiKey,
} from '../utils/vertex_ai_utils.js';
import {
  AddEventsToMemoryRequest,
  AddMemoryRequest,
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from './base_memory_service.js';
import {createMemoryEntry, MemoryEntry} from './memory_entry.js';

/** Keys `memories.generate` accepts as config fields. */
const GENERATE_MEMORIES_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'allowedTopics',
  'disableConsolidation',
  'disableMemoryRevisions',
  'httpOptions',
  'metadata',
  'metadataMergeStrategy',
  'revisionExpireTime',
  'revisionLabels',
  'revisionTtl',
  'ttl',
  'waitForCompletion',
]);

/** Keys `memories.create` accepts as config fields. */
const CREATE_MEMORY_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'description',
  'disableMemoryRevisions',
  'displayName',
  'expireTime',
  'httpOptions',
  'memoryId',
  'metadata',
  'revisionExpireTime',
  'revisionLabels',
  'revisionTtl',
  'topics',
  'ttl',
  'waitForCompletion',
]);

/** Keys `memories.ingestEvents` accepts. */
const INGEST_EVENTS_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'forceFlush',
  'generationTriggerConfig',
  'streamId',
]);

const VERTEX_METADATA_KEYS = [
  'boolValue',
  'doubleValue',
  'stringValue',
  'timestampValue',
] as const;

const ENABLE_CONSOLIDATION_KEY = 'enable_consolidation';
const MAX_DIRECT_MEMORIES_PER_GENERATE_CALL = 5;

const EXPRESS_MODE_PARTIAL_PROJECT_MESSAGE =
  'Vertex AI Express Mode (expressModeApiKey / GOOGLE_API_KEY) cannot be ' +
  'combined with a partial project configuration: the key addresses the ' +
  'project it belongs to, which would silently replace the one you named. ' +
  'Provide both projectId and location, or neither.';

function shouldFilterOutEvent(content?: Content): boolean {
  return !(content?.parts || []).some(
    (p) =>
      p.text ||
      p.inlineData ||
      p.fileData ||
      p.functionCall ||
      p.functionResponse ||
      p.executableCode ||
      p.codeExecutionResult ||
      p.toolCall ||
      p.toolResponse,
  );
}

function eventsWithContent(events: Event[]): Event[] {
  return events.filter((event) => !shouldFilterOutEvent(event.content));
}

/**
 * Returns whether `customMetadata` carries a key that `memories.generate`
 * understands and `memories.ingestEvents` does not. Every other event write
 * goes through `memories.ingestEvents`.
 */
function shouldUseGenerateMemories(
  customMetadata?: Record<string, unknown>,
): boolean {
  if (!customMetadata) {
    return false;
  }
  return Object.keys(customMetadata).some(
    (key) =>
      GENERATE_MEMORIES_KNOWN_FIELDS.has(key) &&
      !INGEST_EVENTS_KNOWN_FIELDS.has(key),
  );
}

/**
 * Narrows a caller-supplied memory generation trigger configuration.
 *
 * Only the top level is checked. The nested rule belongs to the caller, and
 * the Memory Bank API rejects a malformed one.
 */
function isGenerationTriggerConfig(
  value: unknown,
): value is MemoryGenerationTriggerConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toVertexMetadataValue(
  key: string,
  value: unknown,
): MemoryMetadataValue | undefined {
  if (typeof value === 'boolean') {
    return {boolValue: value};
  }
  if (typeof value === 'number') {
    return {doubleValue: value};
  }
  if (typeof value === 'string') {
    return {stringValue: value};
  }
  if (value instanceof Date) {
    return {timestampValue: value.toISOString()};
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as Partial<MemoryMetadataValue>;
    if (
      VERTEX_METADATA_KEYS.some((metadataKey) => v[metadataKey] !== undefined)
    ) {
      return v as MemoryMetadataValue;
    }
    return {stringValue: JSON.stringify(value)};
  }
  if (value === null || value === undefined) {
    logger.warn(
      `Ignoring custom metadata key ${key} because its value is null or undefined.`,
    );
    return undefined;
  }
  return {stringValue: String(value)};
}

// A value of an unrecognised kind passes through unchanged. The optional chain
// keeps a null in a malformed response from throwing.
function fromVertexMetadataValue(value: MemoryMetadataValue): unknown {
  return (
    value?.boolValue ??
    value?.doubleValue ??
    value?.stringValue ??
    value?.timestampValue ??
    value
  );
}

function fromVertexMetadata(
  vertexMetadata?: Record<string, MemoryMetadataValue>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(vertexMetadata ?? {})) {
    metadata[key] = fromVertexMetadataValue(value);
  }
  return metadata;
}

export interface VertexAiMemoryBankServiceOptions {
  projectId?: string;
  location?: string;
  agentEngineId: string;
  expressModeApiKey?: string;
  client?: Client;

  /**
   * Authentication options for the Memory Bank API, e.g. credentials obtained
   * via Workload Identity Federation outside of GCP. Defaults to Application
   * Default Credentials. Ignored in Express Mode, which authenticates with
   * `expressModeApiKey` instead.
   */
  credentials?: GoogleAuthOptions;
}

/**
 * Implementation of the BaseMemoryService using Vertex AI Memory Bank.
 */
export class VertexAiMemoryBankService implements BaseMemoryService {
  private readonly projectId?: string;
  private readonly location?: string;
  private readonly agentEngineId: string;
  private readonly expressModeApiKey?: string;
  private readonly memories: Memories;

  constructor(options: VertexAiMemoryBankServiceOptions) {
    if (!options.agentEngineId) {
      throw new Error(
        'agentEngineId is required for VertexAiMemoryBankService.',
      );
    }

    this.projectId = options.projectId;
    this.location = options.location;
    this.agentEngineId = options.agentEngineId;
    this.expressModeApiKey = getExpressModeApiKey(
      options.projectId,
      options.location,
      options.expressModeApiKey,
    );

    if (options.agentEngineId.includes('/')) {
      logger.warn(
        `agentEngineId appears to be a full resource path: '${options.agentEngineId}'. ` +
          `Expected just the ID (e.g., '456'). ` +
          `Extract the ID using: agentEngine.apiResource.name.split('/').pop()`,
      );
    }

    this.memories = options.client
      ? options.client.agentEnginesInternal.memories
      : createMemoriesClient({
          projectId: this.projectId,
          location: this.location,
          expressModeApiKey: this.expressModeApiKey,
          credentials: options.credentials,
        });
  }

  async addSessionToMemory(session: Session): Promise<void> {
    await this.addEventsToMemoryFromEvents({
      appName: session.appName,
      userId: session.userId,
      eventsToProcess: session.events,
    });
  }

  /**
   * Adds events to Vertex AI Memory Bank via memories.generate.
   */
  async addEventsToMemory(request: AddEventsToMemoryRequest): Promise<void> {
    await this.addEventsToMemoryFromEvents({
      appName: request.appName,
      userId: request.userId,
      eventsToProcess: request.events,
      customMetadata: request.customMetadata,
    });
  }

  /**
   * Adds explicit memory items using Vertex Memory Bank.
   */
  async addMemory(request: AddMemoryRequest): Promise<void> {
    if (isConsolidationEnabled(request.customMetadata)) {
      return this.addMemoriesViaGenerateDirectMemoriesSource(request);
    }

    await this.addMemoriesViaCreate(request);
  }

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse> {
    const params = {
      name: `reasoningEngines/${this.agentEngineId}`,
      scope: {
        app_name: request.appName,
        user_id: request.userId,
      },
      similaritySearchParams: {
        searchQuery: request.query,
      },
    };
    const retrievedMemoriesResponse =
      await this.memories.retrieveInternal(params);

    logger.debug('Search memory response received.');

    const memoryEvents: MemoryEntry[] = [];
    for (const retrievedMemory of retrievedMemoriesResponse.retrievedMemories ||
      []) {
      logger.debug(`Retrieved memory: ${JSON.stringify(retrievedMemory)}`);
      const memory = retrievedMemory.memory;
      if (!memory) {
        logger.warn('Skipping memory entry with missing memory object.');
        continue;
      }
      if (!memory.fact) {
        logger.warn('Skipping memory entry with empty or missing fact.');
        continue;
      }
      memoryEvents.push(
        createMemoryEntry({
          author: 'user',
          content: createUserContent(memory.fact),
          timestamp: memory.updateTime,
          customMetadata: fromVertexMetadata(memory.metadata),
        }),
      );
    }

    return {memories: memoryEvents};
  }

  /**
   * Retrieves the structured profiles for a scope, one per registered schema.
   *
   * Profiles are a Vertex Memory Bank capability distinct from memory search:
   * a scope-keyed lookup rather than a semantic query. It is not part of
   * `BaseMemoryService`.
   */
  async retrieveProfiles(request: {
    appName: string;
    userId: string;
  }): Promise<MemoryProfile[]> {
    const response = await this.memories.retrieveProfiles({
      name: `reasoningEngines/${this.agentEngineId}`,
      scope: {
        app_name: request.appName,
        user_id: request.userId,
      },
    });

    const profiles = Object.values(response.profiles ?? {});
    logger.debug(
      profiles.length > 0
        ? `Retrieved ${profiles.length} memory profiles.`
        : 'Retrieved no memory profiles.',
    );
    return profiles;
  }

  private async addEventsToMemoryFromEvents(request: {
    appName: string;
    userId: string;
    eventsToProcess: Event[];
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!shouldUseGenerateMemories(request.customMetadata)) {
      this.addEventsToMemoryViaIngest(request);
      return;
    }

    const directEvents: GenerateMemoriesRequestDirectContentsSourceEvent[] =
      eventsWithContent(request.eventsToProcess).map((event) => ({
        content: JSON.parse(JSON.stringify(event.content)),
      }));

    if (directEvents.length > 0) {
      const config = buildGenerateMemoriesConfig(request.customMetadata);
      const params = {
        name: `reasoningEngines/${this.agentEngineId}`,
        directContentsSource: {events: directEvents},
        scope: {
          app_name: request.appName,
          user_id: request.userId,
        },
        config: config,
      };
      const operation = await this.memories.generateInternal(params);
      logger.debug('Generate memory response received.');
      logger.debug(`Generate memory response: ${JSON.stringify(operation)}`);
    } else {
      logger.info('No events to add to memory.');
    }
  }

  /**
   * Adds events to Vertex AI Memory Bank via `memories.ingestEvents`.
   *
   * The request is dispatched without being awaited. IngestEvents takes about
   * 800 ms to trigger and its response carries nothing the caller acts on, so
   * awaiting it would only slow the caller down. A failure is logged.
   */
  private addEventsToMemoryViaIngest(request: {
    appName: string;
    userId: string;
    eventsToProcess: Event[];
    customMetadata?: Record<string, unknown>;
  }): void {
    const directEvents = eventsWithContent(request.eventsToProcess).map(
      toIngestionEvent,
    );

    const params: IngestEventsRequestParameters = {
      name: `reasoningEngines/${this.agentEngineId}`,
      scope: {
        app_name: request.appName,
        user_id: request.userId,
      },
      ...ingestOptionsFromMetadata(request.customMetadata),
    };

    // An event-less request is valid: it updates the trigger configuration
    // without flushing the stream.
    if (directEvents.length > 0) {
      params.directContentsSource = {events: directEvents};
    }

    void this.memories.ingestEventsInternal(params).catch((error: unknown) => {
      logger.error(`Background ingestEvents request failed: ${error}`);
    });
    logger.debug('Ingest events request triggered.');
  }

  private async addMemoriesViaCreate(request: {
    appName: string;
    userId: string;
    memories: MemoryEntry[];
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
    const validatedMemories = normalizeMemoriesForCreate(request.memories);

    for (let index = 0; index < validatedMemories.length; index++) {
      const memory = validatedMemories[index];
      const memoryFact = memoryEntryToFact(memory, index);

      const memoryMetadata = mergeCustomMetadataForMemory({
        customMetadata: request.customMetadata,
        memory: memory,
      });

      const memoryRevisionLabels = revisionLabelsForMemory(memory);
      const config = buildCreateMemoryConfig({
        customMetadata: memoryMetadata,
        memoryRevisionLabels,
        memoryId: memory.id,
      });

      const params = {
        name: `reasoningEngines/${this.agentEngineId}`,
        fact: memoryFact,
        scope: {
          app_name: request.appName,
          user_id: request.userId,
        },
        config: config,
      };
      const operation = await this.memories.createInternal(params);
      logger.info('Create memory response received.');
      logger.debug(`Create memory response: ${JSON.stringify(operation)}`);
    }
  }

  private async addMemoriesViaGenerateDirectMemoriesSource(request: {
    appName: string;
    userId: string;
    memories: MemoryEntry[];
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
    const validatedMemories = normalizeMemoriesForCreate(request.memories);
    const memoryTexts = validatedMemories.map((m, i) =>
      memoryEntryToFact(m, i),
    );

    const config = buildGenerateMemoriesConfig(request.customMetadata);
    const memoryBatches = iterMemoryBatches(memoryTexts);

    for (const memoryBatch of memoryBatches) {
      const params = {
        name: `reasoningEngines/${this.agentEngineId}`,
        directMemoriesSource: {
          directMemories: memoryBatch.map((fact) => ({fact})),
        },
        scope: {
          app_name: request.appName,
          user_id: request.userId,
        },
        config: config,
      };
      const operation = await this.memories.generateInternal(params);
      logger.info('Generate direct memory response received.');
      logger.debug(
        `Generate direct memory response: ${JSON.stringify(operation)}`,
      );
    }
  }
}

// Standalone utility functions

function toIngestionEvent(event: Event): IngestionDirectContentsSourceEvent {
  const ingestionEvent: IngestionDirectContentsSourceEvent = {
    content: event.content,
    eventId: event.id,
  };
  // Event.timestamp is in milliseconds; the API expects an RFC 3339 string.
  if (Number.isFinite(event.timestamp)) {
    ingestionEvent.eventTime = new Date(event.timestamp).toISOString();
  }
  return ingestionEvent;
}

function ingestOptionsFromMetadata(
  customMetadata?: Record<string, unknown>,
): Partial<IngestEventsRequestParameters> {
  const options: Partial<IngestEventsRequestParameters> = {};
  if (!customMetadata) {
    return options;
  }

  const streamId = customMetadata['streamId'];
  if (typeof streamId === 'string' && streamId) {
    options.streamId = streamId;
  }

  // forceFlush belongs to the ingest config, not to the request itself.
  const forceFlush = customMetadata['forceFlush'];
  if (typeof forceFlush === 'boolean') {
    options.config = {forceFlush};
  }

  const generationTriggerConfig = customMetadata['generationTriggerConfig'];
  if (isGenerationTriggerConfig(generationTriggerConfig)) {
    options.generationTriggerConfig = generationTriggerConfig;
  }

  return options;
}

/**
 * Builds the Agent Engine `Memories` client for the configured credentials.
 *
 * A complete project and location win over an Express Mode key, so an ambient
 * `GOOGLE_API_KEY` never switches a configured caller to key authentication.
 * Python prefers the key; this divergence is shared with
 * `VertexAiSessionService`.
 *
 * @throws if an Express Mode key meets a half-configured project, because
 *     using the key there would silently address the project the key belongs
 *     to instead of the one the caller named.
 */
function createMemoriesClient(options: {
  projectId?: string;
  location?: string;
  expressModeApiKey?: string;
  credentials?: GoogleAuthOptions;
}): Memories {
  const {
    projectId: project,
    location,
    expressModeApiKey,
    credentials,
  } = options;

  if (expressModeApiKey && !project && !location) {
    return createAgentEngineMemories(
      createExpressModeApiClient(expressModeApiKey),
    );
  }

  if (expressModeApiKey && !(project && location)) {
    throw new Error(EXPRESS_MODE_PARTIAL_PROJECT_MESSAGE);
  }

  if (credentials) {
    return createAgentEngineMemories(
      createVertexApiClient({
        project,
        location,
        googleAuthOptions: credentials,
      }),
    );
  }

  return new Client({project, location}).agentEnginesInternal.memories;
}

/**
 * Builds the Agent Engine `Memories` client from an `ApiClient`.
 *
 * `@google-cloud/vertexai` bundles its own nested copy of `@google/genai`
 * while the repo root resolves `@google/genai` to 2.9.0, so the `ApiClient`
 * here is a structurally distinct class (its private fields make the two
 * nominally incompatible) from the one `Memories` declares. The instances are
 * interchangeable at runtime -- the mismatch is a duplicate-dependency
 * artifact, not a real API difference -- so the cast is confined to this one
 * boundary.
 */
function createAgentEngineMemories(apiClient: ApiClient): Memories {
  return new Memories(
    apiClient as unknown as ConstructorParameters<typeof Memories>[0],
  );
}

function buildCreateMemoryConfig(params: {
  customMetadata?: Record<string, unknown>;
  memoryRevisionLabels?: Record<string, string>;
  memoryId?: string;
}): AgentEngineMemoryConfig {
  const config: Record<string, unknown> = {waitForCompletion: false};

  // Seeded before the loop so an explicit customMetadata memoryId overwrites
  // it and wins over the entry's own id.
  if (params.memoryId !== undefined) {
    config['memoryId'] = params.memoryId;
  }

  if (params.customMetadata) {
    logger.debug(
      `Memory creation metadata: ${JSON.stringify(params.customMetadata)}`,
    );
  }

  const metadataByKey: Record<string, unknown> = {};
  const customRevisionLabels: Record<string, string> = {};

  for (const [key, value] of Object.entries(params.customMetadata || {})) {
    if (key === ENABLE_CONSOLIDATION_KEY) {
      continue;
    }
    if (key === 'metadata') {
      if (value === null || value === undefined) continue;
      if (typeof value === 'object' && !Array.isArray(value)) {
        config['metadata'] = buildVertexMetadata(
          value as Record<string, unknown>,
        );
      } else {
        logger.warn(
          'Ignoring metadata because customMetadata["metadata"] is not an object.',
        );
      }
      continue;
    }
    if (key === 'revisionLabels') {
      if (value === null || value === undefined) continue;
      const extractedLabels = extractRevisionLabels(
        value,
        'customMetadata["revisionLabels"]',
      );
      if (extractedLabels) {
        Object.assign(customRevisionLabels, extractedLabels);
      }
      continue;
    }

    if (CREATE_MEMORY_KNOWN_FIELDS.has(key)) {
      if (value !== null && value !== undefined) {
        config[key] = value;
      }
    } else {
      metadataByKey[key] = value;
    }
  }

  if (Object.keys(metadataByKey).length > 0) {
    const existingMetadata = config['metadata'];
    if (!existingMetadata) {
      config['metadata'] = buildVertexMetadata(metadataByKey);
    } else {
      config['metadata'] = {
        ...existingMetadata,
        ...buildVertexMetadata(metadataByKey),
      };
    }
  }

  // An explicit customMetadata["memoryId"] wins over the entry's own id.
  if (params.memoryId !== undefined && config['memoryId'] === undefined) {
    config['memoryId'] = params.memoryId;
  }

  const revisionLabels = {
    ...customRevisionLabels,
    ...params.memoryRevisionLabels,
  };
  if (Object.keys(revisionLabels).length > 0) {
    config['revisionLabels'] = revisionLabels;
  }

  return config as AgentEngineMemoryConfig;
}

function extractRevisionLabels(
  value: unknown,
  source: string,
): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    logger.warn(`Ignoring ${source} because it is not an object.`);
    return undefined;
  }

  const revisionLabels: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(value)) {
    if (typeof labelValue !== 'string') {
      logger.warn(
        `Ignoring revision label ${key} from ${source} because its value is not a string.`,
      );
      continue;
    }
    revisionLabels[key] = labelValue;
  }

  if (Object.keys(revisionLabels).length === 0) {
    return undefined;
  }
  return revisionLabels;
}

function buildVertexMetadata(
  metadataByKey: Record<string, unknown>,
): Record<string, MemoryMetadataValue> {
  const vertexMetadata: Record<string, MemoryMetadataValue> = {};
  for (const [key, value] of Object.entries(metadataByKey)) {
    const convertedValue = toVertexMetadataValue(key, value);
    if (convertedValue !== undefined) {
      vertexMetadata[key] = convertedValue;
    }
  }
  return vertexMetadata;
}

function buildGenerateMemoriesConfig(
  customMetadata?: Record<string, unknown>,
): GenerateAgentEngineMemoriesConfig {
  const config: Record<string, unknown> = {waitForCompletion: false};
  if (!customMetadata) {
    return config;
  }

  logger.debug(`Memory generation metadata: ${JSON.stringify(customMetadata)}`);

  const metadataByKey: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(customMetadata)) {
    if (key === ENABLE_CONSOLIDATION_KEY) {
      continue;
    }
    if (key === 'ttl') {
      if (value === null || value === undefined) continue;
      if (customMetadata['revisionTtl'] === undefined) {
        config['revisionTtl'] = value as string;
      }
      continue;
    }
    if (key === 'metadata') {
      if (value === null || value === undefined) continue;
      if (typeof value === 'object' && !Array.isArray(value)) {
        config['metadata'] = buildVertexMetadata(
          value as Record<string, unknown>,
        );
      } else {
        logger.warn(
          'Ignoring metadata because customMetadata["metadata"] is not an object.',
        );
      }
      continue;
    }

    // In JS we assume the fields are supported if they are in the type.
    // We just map them if they are known fields.
    if (GENERATE_MEMORIES_KNOWN_FIELDS.has(key)) {
      if (value !== null && value !== undefined) {
        config[key] = value;
      }
    } else {
      metadataByKey[key] = value;
    }
  }

  if (Object.keys(metadataByKey).length > 0) {
    const existingMetadata = config['metadata'];
    if (!existingMetadata) {
      config['metadata'] = buildVertexMetadata(metadataByKey);
    } else {
      config['metadata'] = {
        ...existingMetadata,
        ...buildVertexMetadata(metadataByKey),
      };
    }
  }

  return config as GenerateAgentEngineMemoriesConfig;
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== 'object' || value === null || !('content' in value)) {
    return false;
  }
  const {content} = value;
  return typeof content === 'object' && content !== null;
}

function normalizeMemoriesForCreate(memories: MemoryEntry[]): MemoryEntry[] {
  if (!Array.isArray(memories)) {
    throw new TypeError('memories must be a sequence of memory items.');
  }
  if (memories.length === 0) {
    throw new Error('memories must contain at least one entry.');
  }
  memories.forEach((memory, index) => {
    if (!isMemoryEntry(memory)) {
      throw new TypeError(`memories[${index}] must be a MemoryEntry.`);
    }
  });
  return memories;
}

function memoryEntryToFact(memory: MemoryEntry, index: number): string {
  const textParts: string[] = [];
  if (memory.content && memory.content.parts) {
    for (const part of memory.content.parts) {
      if (part.inlineData || part.fileData) {
        throw new Error(
          `memories[${index}] must include text only; inlineData and fileData are not supported.`,
        );
      }
      if (part.text) {
        const strippedText = part.text.trim();
        if (strippedText) {
          textParts.push(strippedText);
        }
      }
    }
  }

  if (textParts.length === 0) {
    throw new Error(`memories[${index}] must include non-whitespace text.`);
  }
  return textParts.join('\n');
}

function mergeCustomMetadataForMemory(params: {
  customMetadata?: Record<string, unknown>;
  memory: MemoryEntry;
}): Record<string, unknown> | undefined {
  const mergedMetadata: Record<string, unknown> = {};

  if (params.customMetadata) {
    Object.assign(mergedMetadata, params.customMetadata);
  }

  if (params.memory.customMetadata) {
    Object.assign(mergedMetadata, params.memory.customMetadata);
  }

  if (Object.keys(mergedMetadata).length === 0) {
    return undefined;
  }
  return mergedMetadata;
}

function revisionLabelsForMemory(
  memory: MemoryEntry,
): Record<string, string> | undefined {
  const revisionLabels: Record<string, string> = {};
  if (memory.author) {
    revisionLabels['author'] = memory.author;
  }
  if (memory.timestamp) {
    revisionLabels['timestamp'] = memory.timestamp;
  }

  if (Object.keys(revisionLabels).length === 0) {
    return undefined;
  }
  return revisionLabels;
}

function isConsolidationEnabled(
  customMetadata?: Record<string, unknown>,
): boolean {
  if (!customMetadata) {
    return false;
  }
  const enableConsolidation = customMetadata[ENABLE_CONSOLIDATION_KEY];
  if (enableConsolidation === undefined) {
    return false;
  }
  if (typeof enableConsolidation !== 'boolean') {
    throw new TypeError(
      `customMetadata["${ENABLE_CONSOLIDATION_KEY}"] must be a bool.`,
    );
  }
  return enableConsolidation;
}

function iterMemoryBatches(memories: string[]): string[][] {
  const memoryBatches: string[][] = [];
  for (
    let index = 0;
    index < memories.length;
    index += MAX_DIRECT_MEMORIES_PER_GENERATE_CALL
  ) {
    memoryBatches.push(
      memories.slice(index, index + MAX_DIRECT_MEMORIES_PER_GENERATE_CALL),
    );
  }
  return memoryBatches;
}
