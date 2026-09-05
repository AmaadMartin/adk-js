/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared fixtures for the `DiscoveryEngineSearchTool` tests: builders for the
 * REST responses the Discovery Engine `search` method returns, and a reader
 * for the requests the tool sent.
 */

import {
  DiscoveryEngineSearchTool,
  DiscoveryEngineSearchToolParams,
  VertexAISearchDataStoreSpec,
} from '@google/adk';
import {Mock} from 'vitest';

/** The message the API returns when a store only serves DOCUMENTS results. */
export const STRUCTURED_STORE_ERROR =
  '`content_search_spec.search_result_mode` must be set to ' +
  'SearchRequest.ContentSearchSpec.SearchResultMode.DOCUMENTS when the ' +
  'engine contains structured data store.';

/**
 * The argument sets the constructor's discriminated union forbids, but a
 * JavaScript caller or a configuration document can still supply.
 */
export interface LooseParams {
  dataStoreId?: string;
  searchEngineId?: string;
  dataStoreSpecs?: VertexAISearchDataStoreSpec[];
  location?: string;
}

/**
 * Constructs the tool from arguments the compile-time union rejects, so that
 * the constructor's runtime validation is what has to catch them.
 */
export function constructUnchecked(
  params: LooseParams,
): DiscoveryEngineSearchTool {
  return new DiscoveryEngineSearchTool(
    params as DiscoveryEngineSearchToolParams,
  );
}

/** One entry of the `results` array of a `search` response. */
export interface SearchResultItem {
  chunk?: unknown;
  document?: unknown;
}

/** The request body the tool sends, as the test reads it back. */
export interface CapturedSearchRequest {
  query: string;
  contentSearchSpec: {
    searchResultMode: string;
    chunkSpec?: {numPreviousChunks: number; numNextChunks: number};
  };
  dataStoreSpecs?: Array<{dataStore?: string}>;
  filter?: string;
  pageSize?: number;
}

/** One request the tool sent, decoded. */
export interface CapturedRequest {
  url: string;
  headers: Headers;
  body: CapturedSearchRequest;
}

/**
 * The second argument the tool passes to `fetch`. Declared here because
 * `RequestInit` is a type-only global that the lint rules do not recognise.
 */
export interface FetchInit {
  headers: Headers;
  body: string;
}

/** Builds a successful `search` response carrying `results`. */
export function searchResponse(...results: SearchResultItem[]): Response {
  return textResponse(200, JSON.stringify({results}));
}

/** Builds a failed response shaped like the standard Google error envelope. */
export function apiErrorResponse(status: number, message: string): Response {
  return textResponse(
    status,
    JSON.stringify({error: {code: status, message, status: 'ERROR'}}),
  );
}

/** Builds a response with an arbitrary body, for the non-JSON error paths. */
export function textResponse(status: number, body: string): Response {
  return new Response(body, {status});
}

/** Reads the request body of one `fetch` call. */
export function requestBodyOf(init: FetchInit): CapturedSearchRequest {
  return JSON.parse(init.body) as CapturedSearchRequest;
}

/** Decodes every request the stubbed `fetch` received, in order. */
export function capturedRequests(fetchMock: Mock): CapturedRequest[] {
  return fetchMock.mock.calls.map((call) => {
    const [url, init] = call as [string, FetchInit];
    return {url, headers: init.headers, body: requestBodyOf(init)};
  });
}

/** Returns the `searchResultMode` of every request the tool sent, in order. */
export function requestedModes(fetchMock: Mock): string[] {
  return capturedRequests(fetchMock).map(
    (request) => request.body.contentSearchSpec.searchResultMode,
  );
}
