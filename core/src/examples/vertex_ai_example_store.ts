/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  createPartFromText,
  createUserContent,
  Part,
} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';
import {BaseExampleProvider} from './base_example_provider.js';
import {Example} from './example.js';

/** Number of nearest examples requested per search. */
const TOP_K = 10;

/** Results scoring below this floor are dropped. */
const MIN_SIMILARITY_SCORE = 0.5;

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The one location that the unprefixed Vertex AI host serves. */
const GLOBAL_LOCATION = 'global';

const AIPLATFORM_HOST = 'aiplatform.googleapis.com';

const EXAMPLE_STORE_NAME_FORMAT =
  'projects/{project}/locations/{location}/exampleStores/{example_store}';

/**
 * Anchored resource-name pattern that captures the location.
 *
 * The location reaches the request host, and the search carries an Application
 * Default Credentials bearer token. The location character class therefore
 * excludes `/`, `?`, `#` and `@`: each one relocates the URL authority and
 * would send that token to another origin.
 */
const EXAMPLE_STORE_NAME_PATTERN =
  /^projects\/[a-zA-Z0-9_-]+\/locations\/([a-z0-9-]+)\/exampleStores\/[a-zA-Z0-9_-]+$/;

/** A single scored result returned by `searchExamples`. */
export interface SimilarExample {
  similarityScore?: number;
  example?: {
    storedContentsExample?: {
      searchKey?: string;
      contentsExample?: {expectedContents?: Array<{content?: Content}>};
    };
  };
}

/** Response body of the Example Store `searchExamples` method. */
export interface SearchExamplesResponse {
  results?: SimilarExample[];
}

function toSearchHost(location: string): string {
  return location === GLOBAL_LOCATION
    ? AIPLATFORM_HOST
    : `${location}-${AIPLATFORM_HOST}`;
}

/**
 * Converts one stored part, dropping any kind the store round-trips but the
 * few-shot prompt cannot render.
 */
function toPart(part: Part): Part | undefined {
  if (part.text) {
    return createPartFromText(part.text);
  }
  if (part.functionCall) {
    const {name, args} = part.functionCall;
    return {functionCall: {name, args: {...args}}};
  }
  if (part.functionResponse) {
    const {name, response} = part.functionResponse;
    // `createPartFromFunctionResponse` also stamps an `id`, which
    // `convertExamplesToText` would render into the prompt.
    return {functionResponse: {name, response: {...response}}};
  }
  return undefined;
}

function toExample(result: SimilarExample): Example {
  const stored = result.example?.storedContentsExample;
  const expectedContents = stored?.contentsExample?.expectedContents ?? [];
  return {
    input: createUserContent(stored?.searchKey ?? ''),
    output: expectedContents.map(({content}) => ({
      role: content?.role,
      parts: (content?.parts ?? []).flatMap((part) => toPart(part) ?? []),
    })),
  };
}

/**
 * Provides few-shot examples from a Vertex AI Example Store.
 *
 * Each call searches the configured store for the examples nearest to the
 * query, so the curated set can change without redeploying the agent.
 */
export class VertexAiExampleStore extends BaseExampleProvider {
  private readonly auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  private readonly searchUrl: string;

  /**
   * @param examplesStoreName The resource name of the Vertex AI Example Store,
   *   in the format
   *   `projects/{project}/locations/{location}/exampleStores/{example_store}`.
   * @throws {Error} When `examplesStoreName` does not match that format.
   */
  constructor(readonly examplesStoreName: string) {
    super();
    const match = examplesStoreName.match(EXAMPLE_STORE_NAME_PATTERN);
    if (!match) {
      throw new Error(
        `Example store name ${examplesStoreName} is not valid. It should be ` +
          `in the format ${EXAMPLE_STORE_NAME_FORMAT}.`,
      );
    }
    const host = toSearchHost(match[1]);
    this.searchUrl = `https://${host}/v1beta1/${examplesStoreName}:searchExamples`;
  }

  /**
   * Searches the store and returns the examples nearest to `query`.
   *
   * @param query The latest user query to search the store with.
   * @returns The matching examples, in response order. Each example's input is
   *   the stored search key, not `query`.
   */
  override async getExamples(query: string): Promise<Example[]> {
    const {data} = await this.auth.request<SearchExamplesResponse>({
      url: this.searchUrl,
      method: 'POST',
      data: {
        topK: TOP_K,
        storedContentsExampleParameters: {
          contentSearchKey: {
            contents: [createUserContent(query)],
            searchKeyGenerationMethod: {lastEntry: {}},
          },
        },
      },
    });
    const results = (data.results ?? []).filter(
      (result) => (result.similarityScore ?? 0) >= MIN_SIMILARITY_SCORE,
    );
    logger.debug(`Example store search matched ${results.length} examples.`);
    return results.map(toExample);
  }
}
