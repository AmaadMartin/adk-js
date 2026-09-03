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
import {GoogleAuthOptions} from 'google-auth-library';
import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import {
  createVertexApiClient,
  EXPRESS_MODE_UNSUPPORTED_MESSAGE,
  getExpressModeApiKey,
} from '../utils/vertex_ai_utils.js';
import {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from './base_memory_service.js';
import {MemoryEntry} from './memory_entry.js';

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

/**
 * Returns whether an event write should go to `memories.generate`.
 *
 * `memories.ingestEvents` is the default. A caller who passes a key that only
 * `memories.generate` accepts gets the generate path instead; a key both
 * accept, or a key neither accepts, keeps the default.
 */
function shouldUseGenerateMemories(
  customMetadata?: Record<string, unknown>,
): boolean {
  return Object.keys(customMetadata ?? {}).some(
    (key) =>
      !INGEST_EVENTS_KNOWN_FIELDS.has(key) &&
      GENERATE_MEMORIES_KNOWN_FIELDS.has(key),
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

/**
 * Builds the Memories module on an API client that carries the given
 * credentials.
 *
 * The cast bridges two copies of `@google/genai` in the dependency tree:
 * `@google-cloud/vertexai@1.12.0` resolves its own `@google/genai@1.52.0`,
 * while this package resolves `@google/genai@2.9.0`. The two `ApiClient`
 * classes each declare a private `customBaseUrl`, so TypeScript treats them as
 * distinct types even though the instances are interchangeable at runtime.
 */
function createCredentialedMemories(options: {
  project?: string;
  location?: string;
  googleAuthOptions: GoogleAuthOptions;
}): Memories {
  const apiClient = createVertexApiClient(options);
  return new Memories(
    apiClient as unknown as ConstructorParameters<typeof Memories>[0],
  );
}

function toIngestionEvent(event: Event): IngestionDirectContentsSourceEvent {
  const ingestionEvent: IngestionDirectContentsSourceEvent = {
    content: event.content,
    eventId: event.id,
  };
  if (Number.isFinite(event.timestamp)) {
    ingestionEvent.eventTime = new Date(event.timestamp).toISOString();
  }
  return ingestionEvent;
}

/** Converts Vertex metadata values back to plain JavaScript values. */
function fromVertexMetadata(
  metadata?: Record<string, MemoryMetadataValue>,
): Record<string, unknown> {
  const plainMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const setKey = VERTEX_METADATA_KEYS.find((k) => value[k] !== undefined);
    plainMetadata[key] = setKey ? value[setKey] : value;
  }
  return plainMetadata;
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

export interface VertexAiMemoryBankServiceOptions {
  projectId?: string;
  location?: string;
  agentEngineId: string;
  expressModeApiKey?: string;

  /**
   * Authentication options for the Memory Bank API, for example credentials
   * obtained through Workload Identity Federation outside of Google Cloud.
   * Defaults to Application Default Credentials. Ignored when `client` is
   * given, because an injected client carries its own authentication.
   */
  credentials?: GoogleAuthOptions;

  client?: Client;
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

    if (options.client) {
      this.memories = options.client.agentEnginesInternal.memories;
      return;
    }

    if (this.expressModeApiKey && (!this.projectId || !this.location)) {
      throw new Error(EXPRESS_MODE_UNSUPPORTED_MESSAGE);
    }

    if (options.credentials) {
      this.memories = createCredentialedMemories({
        project: this.projectId,
        location: this.location,
        googleAuthOptions: options.credentials,
      });
      return;
    }

    const client = new Client({
      project: this.projectId,
      location: this.location,
    });
    this.memories = client.agentEnginesInternal.memories;
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
  async addEventsToMemory(request: {
    appName: string;
    userId: string;
    events: Event[];
    sessionId?: string;
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
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
  async addMemory(request: {
    appName: string;
    userId: string;
    memories: MemoryEntry[];
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
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
    const retrievedMemories = retrievedMemoriesResponse.retrievedMemories || [];

    for (const retrievedMemory of retrievedMemories) {
      const memory = retrievedMemory.memory;
      if (!memory) {
        logger.warn('Skipping memory entry with missing memory object.');
        continue;
      }
      if (!memory.fact) {
        logger.warn('Skipping memory entry with empty or missing fact.');
        continue;
      }
      memoryEvents.push({
        author: 'user',
        content: createUserContent(memory.fact),
        timestamp: memory.updateTime,
        customMetadata: fromVertexMetadata(memory.metadata),
      });
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

    const directEvents: GenerateMemoriesRequestDirectContentsSourceEvent[] = [];
    for (const event of request.eventsToProcess) {
      if (shouldFilterOutEvent(event.content)) {
        continue;
      }
      // Content might need to be serialized or dumped as in Python
      directEvents.push({
        content: JSON.parse(JSON.stringify(event.content)),
      });
    }

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
    const directEvents = request.eventsToProcess
      .filter((event) => !shouldFilterOutEvent(event.content))
      .map(toIngestionEvent);

    const params: IngestEventsRequestParameters = {
      name: `reasoningEngines/${this.agentEngineId}`,
      scope: {
        app_name: request.appName,
        user_id: request.userId,
      },
    };

    // An event-less request is valid: it updates the trigger configuration
    // without flushing the stream.
    if (directEvents.length > 0) {
      params.directContentsSource = {events: directEvents};
    }

    const customMetadata = request.customMetadata ?? {};
    const streamId = customMetadata['streamId'];
    if (typeof streamId === 'string' && streamId) {
      params.streamId = streamId;
    }
    const forceFlush = customMetadata['forceFlush'];
    if (typeof forceFlush === 'boolean') {
      params.config = {forceFlush};
    }
    const generationTriggerConfig = customMetadata['generationTriggerConfig'];
    if (isGenerationTriggerConfig(generationTriggerConfig)) {
      params.generationTriggerConfig = generationTriggerConfig;
    }

    void this.memories.ingestEventsInternal(params).catch((e: unknown) => {
      logger.error(`Background ingestEvents request failed: ${e}`);
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

function buildCreateMemoryConfig(params: {
  customMetadata?: Record<string, unknown>;
  memoryRevisionLabels?: Record<string, string>;
  memoryId?: string;
}): AgentEngineMemoryConfig {
  const config: Record<string, unknown> = {waitForCompletion: false};

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

function normalizeMemoriesForCreate(memories: MemoryEntry[]): MemoryEntry[] {
  if (!Array.isArray(memories)) {
    throw new TypeError('memories must be a sequence of memory items.');
  }
  if (memories.length === 0) {
    throw new Error('memories must contain at least one entry.');
  }
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
