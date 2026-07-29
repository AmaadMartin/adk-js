/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';

import {getLogger} from '../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';
import {VertexAISearchDataStoreSpec} from './vertex_ai_search_tool.js';

const logger = getLogger();

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const DEFAULT_ENDPOINT = 'discoveryengine.googleapis.com';
const DEFAULT_MTLS_ENDPOINT = 'discoveryengine.mtls.googleapis.com';
const GLOBAL_LOCATION = 'global';

/** Matches `/locations/<loc>` (followed by `/` or end) in a resource id. */
const LOCATION_PATTERN = /\/locations\/([a-z0-9-]+)(?:\/|$)/i;
/** A well-formed location contains only lowercase letters, digits, hyphens. */
const VALID_LOCATION_PATTERN = /^[a-z0-9-]+$/;
/** Error text returned when a structured datastore requires DOCUMENTS mode. */
const STRUCTURED_STORE_ERROR_PATTERN = /search_result_mode.*DOCUMENTS/i;

/**
 * Search result mode for the discovery engine search.
 */
export enum SearchResultMode {
  /** Results as chunks (default). Works for unstructured data. */
  CHUNKS = 'CHUNKS',
  /** Results as documents. Required for structured datastores. */
  DOCUMENTS = 'DOCUMENTS',
}

/**
 * Constructor options for {@link DiscoveryEngineSearchTool}.
 *
 * Exactly one of `dataStoreId` or `searchEngineId` must be provided.
 */
export interface DiscoveryEngineSearchToolParams {
  /**
   * The Vertex AI Search data store resource id, e.g.
   * `projects/{project}/locations/{location}/collections/{collection}/dataStores/{dataStore}`.
   */
  dataStoreId?: string;
  /**
   * Specifications that define the specific data stores to be searched. Only
   * valid together with `searchEngineId`.
   */
  dataStoreSpecs?: VertexAISearchDataStoreSpec[];
  /**
   * The Vertex AI Search engine resource id, e.g.
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   */
  searchEngineId?: string;
  /** The filter to be applied to the search request. */
  filter?: string;
  /** The maximum number of results to return. */
  maxResults?: number;
  /**
   * The search result mode. When omitted the tool auto-detects the correct
   * mode by trying `CHUNKS` first and falling back to `DOCUMENTS` when the
   * datastore requires it. Set explicitly to skip auto-detection.
   */
  searchResultMode?: SearchResultMode;
  /**
   * Optional endpoint location override, e.g. `global`, `us`, `eu`. When
   * omitted, the location is inferred from `dataStoreId`/`searchEngineId` and
   * defaults to `global`.
   */
  location?: string;
}

/** A single parsed search result returned to the model. */
export interface DiscoveryEngineSearchResult {
  title: string;
  url: string;
  content: string;
}

/** The tool response returned to the model. */
export type DiscoveryEngineSearchToolResult =
  | {status: 'success'; results: DiscoveryEngineSearchResult[]}
  | {status: 'error'; error_message: string};

interface DiscoveryEngineChunk {
  content?: string;
  documentMetadata?: {
    title?: string;
    uri?: string;
    structData?: Record<string, unknown>;
  };
}

interface DiscoveryEngineDocument {
  structData?: Record<string, unknown>;
  derivedStructData?: Record<string, unknown>;
}

interface DiscoveryEngineSearchResponse {
  results?: Array<{
    document?: DiscoveryEngineDocument;
    chunk?: DiscoveryEngineChunk;
  }>;
}

/** Coerces an unknown struct-data value to a string, defaulting to empty. */
function asString(value: unknown): string {
  return value == null ? '' : String(value);
}

/** Extracts the message from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalizes and validates a location value, mirroring the Python reference.
 *
 * @param location The raw location string.
 * @param locationType A label (`location` / `resource location`) used to build
 *   the error message so it matches the reference wording.
 */
function normalizeLocation(location: string, locationType: string): string {
  const normalized = location.trim().toLowerCase();
  if (!normalized) {
    throw new Error(`${locationType} must not be empty if specified.`);
  }
  if (!VALID_LOCATION_PATTERN.test(normalized)) {
    throw new Error(
      `${locationType} must contain only letters, digits, and hyphens.`,
    );
  }
  return normalized;
}

/** Extracts and validates the location embedded in a resource id, if any. */
function extractResourceLocation(resourceId: string): string | undefined {
  if (!resourceId.toLowerCase().includes('/locations/')) {
    return undefined;
  }
  const match = LOCATION_PATTERN.exec(resourceId);
  if (!match) {
    throw new Error('Invalid location in dataStoreId or searchEngineId.');
  }
  return normalizeLocation(match[1], 'resource location');
}

/** Resolves the Discovery Engine location to use for the endpoint. */
function resolveLocation(
  resourceId: string,
  location: string | undefined,
): string {
  const inferredLocation = extractResourceLocation(resourceId);

  if (location !== undefined) {
    const normalizedLocation = normalizeLocation(location, 'location');
    if (inferredLocation && normalizedLocation !== inferredLocation) {
      throw new Error(
        'location must match the location in dataStoreId or searchEngineId.',
      );
    }
    return normalizedLocation;
  }

  return inferredLocation ?? GLOBAL_LOCATION;
}

/**
 * Resolves the API host for a location, honoring `GOOGLE_API_USE_MTLS_ENDPOINT`.
 *
 * `always` selects the mTLS host. `auto` (the default), `never`, or an unset
 * value select the plain host: unlike the Python reference,
 * `google-auth-library` does not expose client-certificate detection, so `auto`
 * resolves to the non-mTLS host — the same observable result in a standard
 * server environment.
 */
function buildEndpoint(resolvedLocation: string): string {
  const useMtls =
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT']?.toLowerCase() === 'always';
  const host = useMtls ? DEFAULT_MTLS_ENDPOINT : DEFAULT_ENDPOINT;
  return resolvedLocation === GLOBAL_LOCATION
    ? host
    : `${resolvedLocation}-${host}`;
}

/**
 * Client-side active-retrieval tool that queries a Vertex AI Search (Discovery
 * Engine / Agentspace) data store or search engine at tool-call time and
 * returns the parsed results to the model.
 */
export class DiscoveryEngineSearchTool extends BaseTool {
  private readonly servingConfig: string;
  private readonly dataStoreSpecs?: VertexAISearchDataStoreSpec[];
  private readonly filter?: string;
  private readonly maxResults?: number;
  private readonly endpoint: string;
  private readonly auth: GoogleAuth;
  /** Cached resolved mode; mutated by auto-detection. */
  private searchResultMode?: SearchResultMode;

  constructor(params: DiscoveryEngineSearchToolParams) {
    super({
      name: 'discovery_engine_search',
      description:
        "Search through Vertex AI Search's discovery engine search API.",
    });

    const {
      dataStoreId,
      dataStoreSpecs,
      searchEngineId,
      filter,
      maxResults,
      searchResultMode,
      location,
    } = params;

    const resourceId = dataStoreId ?? searchEngineId;
    if (
      resourceId === undefined ||
      (dataStoreId !== undefined && searchEngineId !== undefined)
    ) {
      throw new Error(
        'Either dataStoreId or searchEngineId must be specified.',
      );
    }
    if (dataStoreSpecs !== undefined && searchEngineId === undefined) {
      throw new Error(
        'searchEngineId must be specified if dataStoreSpecs is specified.',
      );
    }

    this.servingConfig = `${resourceId}/servingConfigs/default_config`;
    this.dataStoreSpecs = dataStoreSpecs;
    this.filter = filter;
    this.maxResults = maxResults;
    this.searchResultMode = searchResultMode;

    // Validate/resolve the location synchronously so bad input throws before
    // any auth or network work happens (mirrors the Python constructor).
    this.endpoint = buildEndpoint(resolveLocation(resourceId, location));
    this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {type: Type.STRING, description: 'The search query.'},
        },
        required: ['query'],
      },
    };
  }

  override async runAsync({
    args,
  }: RunAsyncToolRequest): Promise<DiscoveryEngineSearchToolResult> {
    return this.discoveryEngineSearch(args['query'] as string);
  }

  /**
   * Searches the Discovery Engine and returns parsed results.
   *
   * When `searchResultMode` is unset, auto-detects the mode by trying `CHUNKS`
   * first and falling back to `DOCUMENTS` on the structured-store error. The
   * resolved mode is cached so later calls skip the retry.
   */
  async discoveryEngineSearch(
    query: string,
  ): Promise<DiscoveryEngineSearchToolResult> {
    try {
      if (this.searchResultMode) {
        return await this.doSearch(query, this.searchResultMode);
      }

      try {
        const result = await this.doSearch(query, SearchResultMode.CHUNKS);
        this.searchResultMode = SearchResultMode.CHUNKS;
        return result;
      } catch (error) {
        if (!STRUCTURED_STORE_ERROR_PATTERN.test(messageOf(error))) {
          throw error;
        }
        logger.debug(
          'CHUNKS mode failed for structured datastore, retrying with ' +
            'DOCUMENTS mode.',
        );
        this.searchResultMode = SearchResultMode.DOCUMENTS;
        return await this.doSearch(query, SearchResultMode.DOCUMENTS);
      }
    } catch (error) {
      return {status: 'error', error_message: messageOf(error)};
    }
  }

  /** Executes a single search request with the given mode. */
  private async doSearch(
    query: string,
    mode: SearchResultMode,
  ): Promise<DiscoveryEngineSearchToolResult> {
    const body: Record<string, unknown> = {
      query,
      contentSearchSpec: buildContentSearchSpec(mode),
    };
    if (this.dataStoreSpecs) {
      body['dataStoreSpecs'] = this.dataStoreSpecs;
    }
    if (this.filter) {
      body['filter'] = this.filter;
    }
    if (this.maxResults) {
      body['pageSize'] = this.maxResults;
    }

    const url = `https://${this.endpoint}/v1beta/${this.servingConfig}:search`;
    const headers = await this.getAuthHeaders();
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Discovery Engine search failed with status ${res.status}: ${text}`,
      );
    }

    const data = (await res.json()) as DiscoveryEngineSearchResponse;
    const results: DiscoveryEngineSearchResult[] = [];
    for (const item of data.results ?? []) {
      if (mode === SearchResultMode.DOCUMENTS) {
        if (!item.document) {
          continue;
        }
        results.push(parseDocumentResult(item.document));
      } else {
        if (!item.chunk) {
          continue;
        }
        results.push(parseChunkResult(item.chunk));
      }
    }
    return {status: 'success', results};
  }

  /** Resolves ADC and builds the request headers for a search call. */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const client = await this.auth.getClient();
    const rawHeaders = await client.getRequestHeaders(
      `https://${this.endpoint}`,
    );
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const authorization = rawHeaders.get('authorization');
    if (authorization) {
      headers['Authorization'] = authorization;
    }
    if (client.quotaProjectId) {
      headers['x-goog-user-project'] = client.quotaProjectId;
    }
    return headers;
  }
}

/** Builds the `contentSearchSpec` for a given mode. */
function buildContentSearchSpec(
  mode: SearchResultMode,
): Record<string, unknown> {
  if (mode === SearchResultMode.DOCUMENTS) {
    return {searchResultMode: SearchResultMode.DOCUMENTS};
  }
  return {
    searchResultMode: SearchResultMode.CHUNKS,
    chunkSpec: {numPreviousChunks: 0, numNextChunks: 0},
  };
}

/** Parses a CHUNKS search result into a `{title, url, content}` record. */
function parseChunkResult(
  chunk: DiscoveryEngineChunk,
): DiscoveryEngineSearchResult {
  let title = '';
  let url = '';
  const metadata = chunk.documentMetadata;
  if (metadata) {
    title = metadata.title ?? '';
    url = metadata.uri ?? '';
    // Prefer the URI from structData when present.
    if (metadata.structData && 'uri' in metadata.structData) {
      url = asString(metadata.structData['uri']);
    }
  }
  return {title, url, content: chunk.content ?? ''};
}

/** Parses a DOCUMENTS search result into a `{title, url, content}` record. */
function parseDocumentResult(
  doc: DiscoveryEngineDocument,
): DiscoveryEngineSearchResult {
  let title = '';
  let url = '';
  let content = '';

  if (doc.structData) {
    // Structured data: title/uri live in structData; the rest becomes content.
    const data: Record<string, unknown> = {...doc.structData};
    title = asString(data['title']);
    delete data['title'];
    const link = asString(data['link']);
    delete data['link'];
    if ('uri' in data) {
      url = asString(data['uri']);
      delete data['uri'];
    } else {
      url = link;
    }
    content = JSON.stringify(data);
  } else if (doc.derivedStructData) {
    // Unstructured data: fields live in derivedStructData.
    const data = doc.derivedStructData;
    title = asString(data['title']);
    url = asString(data['link']);
    const snippets = data['snippets'];
    if (Array.isArray(snippets) && snippets.length > 0) {
      content = renderEntries(snippets, 'snippet');
    }
    // `derivedStructData` is a `google.protobuf.Struct`, so its keys are data
    // rather than proto fields and are NOT camelCased by JSON transcoding.
    const extractiveAnswers = data['extractive_answers'];
    if (
      !content &&
      Array.isArray(extractiveAnswers) &&
      extractiveAnswers.length > 0
    ) {
      content = renderEntries(extractiveAnswers, 'content');
    }
  }

  return {title, url, content};
}

/**
 * Renders `derivedStructData` list entries to text.
 *
 * Entries are objects carrying the text under `textKey` (`snippet` for
 * snippets, `content` for extractive answers); anything else is stringified.
 */
function renderEntries(entries: unknown[], textKey: string): string {
  return entries
    .map((entry) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const text = (entry as Record<string, unknown>)[textKey];
        return text ? asString(text) : JSON.stringify(entry);
      }
      return asString(entry);
    })
    .join('\n');
}
