/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, GoogleAuth} from 'google-auth-library';
import {z} from 'zod';

import {asRecord, formatError} from '../utils/error_utils.js';
import {getLogger} from '../utils/logger.js';
import {getApiEndpoint} from '../utils/mtls_utils.js';
import {FunctionTool} from './function_tool.js';
import {VertexAISearchDataStoreSpec} from './vertex_ai_search_tool.js';

const logger = getLogger();

/** Discovery Engine REST API version this tool calls. */
const API_VERSION = 'v1beta';

/** Host serving data stores that are not pinned to a region. */
const DEFAULT_ENDPOINT = 'discoveryengine.googleapis.com';

/** Mutual-TLS variant of {@link DEFAULT_ENDPOINT}. */
const DEFAULT_MTLS_ENDPOINT = 'discoveryengine.mtls.googleapis.com';

/** The location a data store carries when it is not pinned to a region. */
const GLOBAL_LOCATION = 'global';

/** OAuth scope every Discovery Engine call needs. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Matches the API's complaint that a store only serves DOCUMENTS results. */
const STRUCTURED_STORE_ERROR_PATTERN = /search_result_mode.*DOCUMENTS/i;

/** Extracts the location segment out of a data store or engine resource id. */
const LOCATION_PATTERN = /\/locations\/([a-z0-9-]+)(?:\/|$)/i;

/** The shape a location has to have once it is trimmed and lowercased. */
const VALID_LOCATION_PATTERN = /^[a-z0-9-]+$/;

/** The function name the model calls. */
const TOOL_NAME = 'discovery_engine_search';

/** What the model is told the tool does. */
const TOOL_DESCRIPTION =
  'Searches a Vertex AI Search data store and returns the matching titles, ' +
  'urls and content.';

/** The arguments the model supplies, validated before the tool runs. */
const SEARCH_PARAMETERS = z.object({
  query: z.string().describe('The search query.'),
});

/** How the Discovery Engine `search` API shapes its results. */
export enum SearchResultMode {
  /** Results as chunks (default). Works for unstructured data. */
  CHUNKS = 'CHUNKS',
  /** Results as documents. Required for structured datastores. */
  DOCUMENTS = 'DOCUMENTS',
}

/** One search hit, as the model receives it. */
export interface DiscoveryEngineSearchResult {
  /** The document title, or an empty string when the store has none. */
  title: string;
  /** The document location, or an empty string when the store has none. */
  url: string;
  /** The matching text, or the remaining structured fields as JSON. */
  content: string;
}

/**
 * What {@link DiscoveryEngineSearchTool} answers the model with.
 *
 * `error_message` is snake_case because it crosses the model boundary and has
 * to match what adk-python emits.
 */
export type DiscoveryEngineSearchResponse =
  | {status: 'success'; results: DiscoveryEngineSearchResult[]}
  | {status: 'error'; error_message: string};

/** The options both forms of {@link DiscoveryEngineSearchToolParams} accept. */
export interface BaseDiscoveryEngineSearchToolParams {
  /** Sent as the request `filter`, in the Discovery Engine filter syntax. */
  filter?: string;
  /** Sent as the request `pageSize`. Ignored when it is 0. */
  maxResults?: number;
  /** Omit to auto-detect: CHUNKS first, DOCUMENTS on a structured store. */
  searchResultMode?: SearchResultMode;
  /** Endpoint location override, e.g. 'global', 'us', 'eu'. */
  location?: string;
}

/** Searching one data store. */
export interface DiscoveryEngineDataStoreParams extends BaseDiscoveryEngineSearchToolParams {
  /**
   * The data store to search, as
   * `projects/{project}/locations/{location}/collections/{collection}/dataStores/{dataStore}`.
   */
  dataStoreId: string;
  searchEngineId?: never;
  dataStoreSpecs?: never;
}

/** Searching a search engine, optionally narrowed to some of its stores. */
export interface DiscoveryEngineSearchEngineParams extends BaseDiscoveryEngineSearchToolParams {
  /**
   * The engine to search, as
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   */
  searchEngineId: string;
  dataStoreId?: never;
  /** Narrows the engine's search to these data stores. */
  dataStoreSpecs?: VertexAISearchDataStoreSpec[];
}

/** What {@link DiscoveryEngineSearchTool} is constructed from. */
export type DiscoveryEngineSearchToolParams =
  | DiscoveryEngineDataStoreParams
  | DiscoveryEngineSearchEngineParams;

/** How many chunks either side of a hit the API returns. */
interface ChunkSpec {
  numPreviousChunks: number;
  numNextChunks: number;
}

/** The `contentSearchSpec` of a search request. */
interface ContentSearchSpec {
  searchResultMode: SearchResultMode;
  chunkSpec?: ChunkSpec;
}

/** The body of a Discovery Engine `search` request. */
interface SearchRequestBody {
  query: string;
  contentSearchSpec: ContentSearchSpec;
  dataStoreSpecs?: VertexAISearchDataStoreSpec[];
  filter?: string;
  pageSize?: number;
}

/** The part of a `chunk` result this tool reads. */
interface ChunkResult {
  content?: string;
  documentMetadata?: {
    title?: string;
    uri?: string;
    structData?: Record<string, unknown>;
  };
}

/** The part of a `document` result this tool reads. */
interface DocumentResult {
  structData?: Record<string, unknown>;
  derivedStructData?: Record<string, unknown>;
}

/** The part of a `search` response this tool reads. */
interface SearchResponseBody {
  results?: Array<{chunk?: ChunkResult; document?: DocumentResult}>;
}

/** What the shared CHUNKS probe tells the callers waiting on it. */
interface ProbeOutcome {
  /** The mode every caller uses from now on. */
  mode: SearchResultMode;
  /** The probe's own results, present only when CHUNKS succeeded. */
  results?: DiscoveryEngineSearchResult[];
}

/**
 * Narrows away a message the API left out. An object with no fields is the
 * JSON form of an unset message, so it counts as absent too.
 */
function isPresent<T extends object>(value: T | undefined): value is T {
  return value !== undefined && Object.keys(value).length > 0;
}

/** Renders a JSON value as text. An absent value reads as an empty string. */
function asText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  return JSON.stringify(value);
}

/** Trims and lowercases a location, rejecting anything that is not one. */
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

/**
 * Reads the location out of a resource id, or `undefined` when it names none.
 *
 * @throws If the id has a `/locations/` segment that is not a location.
 */
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

/**
 * Decides which location the endpoint serves.
 *
 * @throws If the override is not a location, or contradicts the resource id.
 */
function resolveLocation(resourceId: string, location?: string): string {
  const inferred = extractResourceLocation(resourceId);
  if (location === undefined) {
    return inferred ?? GLOBAL_LOCATION;
  }
  const normalized = normalizeLocation(location, 'location');
  if (inferred !== undefined && normalized !== inferred) {
    throw new Error(
      'location must match the location in dataStoreId or searchEngineId.',
    );
  }
  return normalized;
}

/** Returns the host that serves `location`, honouring the mutual-TLS setting. */
function resolveHost(location: string): string {
  const prefix = location === GLOBAL_LOCATION ? '' : '{location}-';
  return getApiEndpoint(
    location,
    `${prefix}${DEFAULT_ENDPOINT}`,
    `${prefix}${DEFAULT_MTLS_ENDPOINT}`,
  );
}

/** Builds the `contentSearchSpec` that asks for results in `mode`. */
function buildContentSearchSpec(mode: SearchResultMode): ContentSearchSpec {
  if (mode === SearchResultMode.DOCUMENTS) {
    return {searchResultMode: mode};
  }
  return {
    searchResultMode: mode,
    chunkSpec: {numPreviousChunks: 0, numNextChunks: 0},
  };
}

/** Turns a `chunk` result into the record the model receives. */
function parseChunkResult(chunk: ChunkResult): DiscoveryEngineSearchResult {
  const metadata = chunk.documentMetadata;
  const structData = metadata?.structData;
  // A uri in the struct data is the document's own, so it wins.
  const url =
    structData !== undefined && 'uri' in structData
      ? asText(structData['uri'])
      : asText(metadata?.uri);
  return {title: asText(metadata?.title), url, content: asText(chunk.content)};
}

/**
 * Turns the structured fields of a document into the record the model
 * receives. The title and the location are lifted out, and whatever is left
 * becomes the content.
 */
function parseStructuredDocument(
  structData: Record<string, unknown>,
): DiscoveryEngineSearchResult {
  const rest = {...structData};
  const title = asText(rest['title']);
  // `link` is removed whether or not `uri` supplied the location, so the two
  // never both reach the content. adk-python does the same, because it
  // evaluates `link` as the default of the `uri` lookup.
  const link = asText(rest['link']);
  const uri = 'uri' in rest ? asText(rest['uri']) : link;
  delete rest['title'];
  delete rest['link'];
  delete rest['uri'];
  return {title, url: uri, content: JSON.stringify(rest)};
}

/** Joins the snippets of an unstructured document into one block of text. */
function joinSnippets(snippets: unknown[]): string {
  return snippets
    .map((entry) => {
      const snippet = asRecord(entry)?.['snippet'];
      return snippet ? asText(snippet) : asText(entry);
    })
    .join('\n');
}

/**
 * Turns the crawler-derived fields of a document into the record the model
 * receives. The content is the snippets, or the extractive answers when the
 * store returned no snippets.
 */
function parseDerivedDocument(
  derived: Record<string, unknown>,
): DiscoveryEngineSearchResult {
  const snippets = derived['snippets'];
  const answers = derived['extractive_answers'];
  let content = Array.isArray(snippets) ? joinSnippets(snippets) : '';
  if (!content && Array.isArray(answers)) {
    content = answers.map(asText).join('\n');
  }
  return {
    title: asText(derived['title']),
    url: asText(derived['link']),
    content,
  };
}

/** Turns a `document` result into the record the model receives. */
function parseDocumentResult(doc: DocumentResult): DiscoveryEngineSearchResult {
  if (isPresent(doc.structData)) {
    return parseStructuredDocument(doc.structData);
  }
  if (isPresent(doc.derivedStructData)) {
    return parseDerivedDocument(doc.derivedStructData);
  }
  return {title: '', url: '', content: ''};
}

/** Turns one page of search results into the records the model receives. */
function parseResults(
  body: SearchResponseBody,
  mode: SearchResultMode,
): DiscoveryEngineSearchResult[] {
  const results: DiscoveryEngineSearchResult[] = [];
  for (const item of body.results ?? []) {
    if (mode === SearchResultMode.DOCUMENTS) {
      if (isPresent(item.document)) {
        results.push(parseDocumentResult(item.document));
      }
    } else if (isPresent(item.chunk)) {
      results.push(parseChunkResult(item.chunk));
    }
  }
  return results;
}

/**
 * Reads the message out of a failed search: the one the standard Google error
 * envelope carries, or the raw body when the response is not one.
 */
function apiErrorMessage(status: number, body: string): string {
  try {
    const message = asRecord(asRecord(JSON.parse(body))?.['error'])?.[
      'message'
    ];
    if (typeof message === 'string') {
      return message;
    }
  } catch {
    // Not JSON, so the body itself is the best message available.
  }
  return body || `Discovery Engine search failed with HTTP ${status}.`;
}

/**
 * Searches a Vertex AI Search (Discovery Engine) data store or search engine,
 * and hands the model back the matching titles, urls and content.
 *
 * Unlike `VertexAiSearchTool`, which asks Gemini to ground itself, this tool
 * issues the search itself, so it works on any model.
 */
export class DiscoveryEngineSearchTool extends FunctionTool<
  typeof SEARCH_PARAMETERS
> {
  private readonly servingConfig: string;
  private readonly host: string;
  private readonly dataStoreSpecs?: VertexAISearchDataStoreSpec[];
  private readonly filter?: string;
  private readonly maxResults?: number;
  private readonly auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  private searchResultMode?: SearchResultMode;
  private modeProbe?: Promise<ProbeOutcome>;
  private client?: Promise<AuthClient>;

  constructor(params: DiscoveryEngineSearchToolParams) {
    super({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: SEARCH_PARAMETERS,
      execute: ({query}) => this.discoveryEngineSearch(query),
    });

    const {dataStoreId, searchEngineId, dataStoreSpecs} = params;
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
    // Resolved here, as in adk-python, so the mutual-TLS environment is
    // sampled when the tool is built rather than when it first searches.
    this.host = resolveHost(resolveLocation(resourceId, params.location));
    this.dataStoreSpecs = dataStoreSpecs;
    this.filter = params.filter;
    this.maxResults = params.maxResults;
    this.searchResultMode = params.searchResultMode;
  }

  /**
   * Searches through the Vertex AI Search discovery engine search API.
   *
   * @param query The search query.
   * @return The search results, or the message explaining why there are none.
   */
  async discoveryEngineSearch(
    query: string,
  ): Promise<DiscoveryEngineSearchResponse> {
    try {
      const mode = this.searchResultMode;
      const results =
        mode === undefined
          ? await this.autoDetectSearch(query)
          : await this.doSearch(query, mode);
      return {status: 'success', results};
    } catch (error: unknown) {
      return {status: 'error', error_message: formatError(error)};
    }
  }

  /**
   * Searches with the mode the store needs, detecting it on the first call.
   *
   * Detection is per data store, not per query, so the probe is single-flight:
   * concurrent first callers share one CHUNKS request instead of each spending
   * their own before they all learn the same answer.
   */
  private async autoDetectSearch(
    query: string,
  ): Promise<DiscoveryEngineSearchResult[]> {
    const inFlight = this.modeProbe;
    if (inFlight !== undefined) {
      return this.doSearch(query, (await inFlight).mode);
    }
    const probe = this.probeMode(query);
    this.modeProbe = probe;
    const outcome = await probe;
    return outcome.results ?? this.doSearch(query, outcome.mode);
  }

  /**
   * Runs the first search in CHUNKS mode and records what the store accepts.
   *
   * @throws The API failure, when it is not the structured-store complaint.
   */
  private async probeMode(query: string): Promise<ProbeOutcome> {
    try {
      const results = await this.doSearch(query, SearchResultMode.CHUNKS);
      this.searchResultMode = SearchResultMode.CHUNKS;
      return {mode: SearchResultMode.CHUNKS, results};
    } catch (error: unknown) {
      if (!STRUCTURED_STORE_ERROR_PATTERN.test(formatError(error))) {
        // Nothing was learned about the store, so let a later call probe again.
        this.modeProbe = undefined;
        throw error;
      }
      logger.debug(
        'CHUNKS mode failed for structured datastore, retrying with DOCUMENTS mode.',
      );
      this.searchResultMode = SearchResultMode.DOCUMENTS;
      return {mode: SearchResultMode.DOCUMENTS};
    }
  }

  /** Issues one search request and parses what it returns. */
  private async doSearch(
    query: string,
    mode: SearchResultMode,
  ): Promise<DiscoveryEngineSearchResult[]> {
    const body: SearchRequestBody = {
      query,
      contentSearchSpec: buildContentSearchSpec(mode),
    };
    if (this.dataStoreSpecs) {
      body.dataStoreSpecs = this.dataStoreSpecs;
    }
    if (this.filter) {
      body.filter = this.filter;
    }
    if (this.maxResults) {
      body.pageSize = this.maxResults;
    }
    return parseResults(await this.post(body), mode);
  }

  /**
   * Sends one authenticated `search` request.
   *
   * @throws If the API answers with anything other than success.
   */
  private async post(body: SearchRequestBody): Promise<SearchResponseBody> {
    const url = `https://${this.host}/${API_VERSION}/${this.servingConfig}:search`;
    const client = await (this.client ??= this.auth.getClient());
    // The client sets `x-goog-user-project` from the credentials' quota
    // project, which is what adk-python passes through client options.
    const headers = new Headers(await client.getRequestHeaders(url));
    headers.set('Content-Type', 'application/json');

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(apiErrorMessage(response.status, text));
    }
    return JSON.parse(text) as SearchResponseBody;
  }
}
