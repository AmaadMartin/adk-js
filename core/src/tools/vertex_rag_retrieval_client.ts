/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  RagRetrievalConfig,
  VertexRagStore,
  VertexRagStoreRagResource,
} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';

import {getLogger} from '../utils/logger.js';

const logger = getLogger();

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const RAG_CORPUS_PATTERN =
  /^projects\/([^/]+)\/locations\/([^/]+)\/ragCorpora\//;

/** One retrieved chunk, mirroring the REST `Context` message. */
export interface RagContext {
  text?: string;
}

/** The parameters for {@link retrieveRagContexts}. */
export interface RetrieveRagContextsParams {
  query: string;
  vertexRagStore: VertexRagStore;
}

interface RetrieveContextsResponse {
  contexts?: {contexts?: RagContext[]};
}

const sharedAuth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});

/**
 * Returns the rag resources the store names.
 *
 * `ragCorpora` is deprecated in `VertexRagStore` and the request-level store
 * has no such field, so a corpus name is lifted into a `{ragCorpus}` resource.
 */
export function toRagResources(
  store: VertexRagStore,
): VertexRagStoreRagResource[] {
  if (store.ragResources && store.ragResources.length > 0) {
    return store.ragResources;
  }
  return (store.ragCorpora ?? []).map((ragCorpus) => ({ragCorpus}));
}

/**
 * Resolves the project and location to call.
 *
 * A fully qualified `ragCorpus` names both. When none of the resources carries
 * one, the environment supplies them.
 *
 * @throws Error when neither source resolves a project and a location.
 */
export function resolveRagLocation(resources: VertexRagStoreRagResource[]): {
  project: string;
  location: string;
} {
  for (const {ragCorpus} of resources) {
    const match = ragCorpus?.match(RAG_CORPUS_PATTERN);
    if (match) {
      return {project: match[1], location: match[2]};
    }
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION;
  if (!project || !location) {
    throw new Error(
      'Vertex AI RAG retrieval could not resolve the project and location. ' +
        'Provide a fully qualified ragCorpus resource name, or set ' +
        'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.',
    );
  }
  return {project, location};
}

/**
 * Returns the retrieval config to send with the query.
 *
 * `similarityTopK` and `vectorDistanceThreshold` are the legacy spellings of
 * `ragRetrievalConfig.topK` and `ragRetrievalConfig.filter`, so they are
 * translated when the caller did not supply a config.
 */
export function toRagRetrievalConfig(
  store: VertexRagStore,
): RagRetrievalConfig | undefined {
  if (store.ragRetrievalConfig) {
    return store.ragRetrievalConfig;
  }

  const {similarityTopK, vectorDistanceThreshold} = store;
  if (similarityTopK === undefined && vectorDistanceThreshold === undefined) {
    return undefined;
  }

  return {
    topK: similarityTopK,
    filter:
      vectorDistanceThreshold === undefined
        ? undefined
        : {vectorDistanceThreshold},
  };
}

/**
 * Retrieves the contexts that match a query, through the Vertex AI RAG Engine
 * `retrieveContexts` REST method.
 *
 * The call authenticates with Application Default Credentials. An empty result
 * is a normal outcome and resolves to an empty array.
 *
 * @throws Error when the store names no corpus, when the project and location
 *     cannot be resolved, or when the API answers with a non-2xx status.
 */
export async function retrieveRagContexts({
  query,
  vertexRagStore,
}: RetrieveRagContextsParams): Promise<RagContext[]> {
  const ragResources = toRagResources(vertexRagStore);
  if (ragResources.length === 0) {
    throw new Error(
      'Vertex AI RAG retrieval requires ragResources or ragCorpora.',
    );
  }

  const {project, location} = resolveRagLocation(ragResources);
  const url =
    `https://${location}-aiplatform.googleapis.com/v1` +
    `/projects/${project}/locations/${location}:retrieveContexts`;

  const response = await fetch(url, {
    method: 'POST',
    headers: await getAuthHeaders(url),
    body: JSON.stringify({
      vertexRagStore: {ragResources},
      query: {
        text: query,
        ragRetrievalConfig: toRagRetrievalConfig(vertexRagStore),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Vertex AI RAG retrieval failed with status ${response.status}: ` +
        `${await response.text()}`,
    );
  }

  const payload = (await response.json()) as RetrieveContextsResponse;
  const contexts = payload.contexts?.contexts ?? [];
  logger.debug(`Vertex AI RAG retrieval returned ${contexts.length} contexts.`);
  return contexts;
}

async function getAuthHeaders(url: string): Promise<Headers> {
  const client = await sharedAuth.getClient();
  const headers = await client.getRequestHeaders(url);
  headers.set('Content-Type', 'application/json');
  return headers;
}
