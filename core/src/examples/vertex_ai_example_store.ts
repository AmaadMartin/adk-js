/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createUserContent, Part} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';

import {experimental} from '../utils/experimental.js';
import {BaseExampleProvider} from './base_example_provider.js';
import {Example} from './example.js';

const DEFAULT_TOP_K = 10;

/** Results scoring below this are dropped, matching adk-python. */
const MIN_SIMILARITY_SCORE = 0.5;

const EXAMPLE_STORE_NAME_PATTERN =
  /^projects\/[^/]+\/locations\/([^/]+)\/exampleStores\/[^/]+$/;

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Options for {@link VertexAiExampleStore}. */
export interface VertexAiExampleStoreOptions {
  /**
   * The resource name of the Vertex AI Example Store, in the format
   * `projects/{project}/locations/{location}/exampleStores/{example_store}`.
   */
  examplesStoreName: string;
  /** Client override, primarily for tests. Defaults to a REST client. */
  client?: ExampleStoreClient;
}

/** Request body for the Example Store `searchExamples` method. */
export interface SearchExamplesRequest {
  exampleStore: string;
  topK: number;
  storedContentsExampleParameters: {
    contentSearchKey: {
      contents: Content[];
      searchKeyGenerationMethod: {lastEntry: Record<string, never>};
    };
  };
}

/**
 * A single scored result returned by `searchExamples`.
 *
 * Fields holding a proto3 default value are omitted from the JSON response, so
 * everything but the nested messages themselves is optional.
 */
export interface SimilarExample {
  similarityScore?: number;
  example: {
    storedContentsExample: {
      searchKey?: string;
      contentsExample?: {expectedContents?: Array<{content: Content}>};
    };
  };
}

/** Response body of the Example Store `searchExamples` method. */
export interface SearchExamplesResponse {
  results?: SimilarExample[];
}

/** The Example Store search surface used by {@link VertexAiExampleStore}. */
export interface ExampleStoreClient {
  searchExamples(
    request: SearchExamplesRequest,
  ): Promise<SearchExamplesResponse>;
}

/**
 * Calls the Vertex AI Example Store REST API with Application Default
 * Credentials.
 */
class VertexAiExampleStoreRestClient implements ExampleStoreClient {
  private readonly auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});

  constructor(private readonly location: string) {}

  async searchExamples(
    request: SearchExamplesRequest,
  ): Promise<SearchExamplesResponse> {
    const url =
      `https://${this.location}-aiplatform.googleapis.com/v1beta1/` +
      `${request.exampleStore}:searchExamples`;
    const response = await this.auth.request<SearchExamplesResponse>({
      url,
      method: 'POST',
      data: request,
    });
    return response.data;
  }
}

/**
 * Narrows a stored part to the kinds the Example Store round-trips: text,
 * function calls and function responses. Any other kind is dropped.
 */
function toPart(part: Part): Part | undefined {
  if (part.text) {
    return {text: part.text};
  }
  if (part.functionCall) {
    return {
      functionCall: {
        name: part.functionCall.name,
        args: {...part.functionCall.args},
      },
    };
  }
  if (part.functionResponse) {
    return {
      functionResponse: {
        name: part.functionResponse.name,
        response: {...part.functionResponse.response},
      },
    };
  }
  return undefined;
}

function toExpectedOutput(result: SimilarExample): Content[] {
  const {expectedContents = []} =
    result.example.storedContentsExample.contentsExample ?? {};
  return expectedContents.map(({content}) => ({
    role: content.role,
    parts: (content.parts ?? []).flatMap((part) => toPart(part) ?? []),
  }));
}

function toExample(result: SimilarExample): Example {
  return {
    input: createUserContent(
      result.example.storedContentsExample.searchKey ?? '',
    ),
    output: toExpectedOutput(result),
  };
}

/**
 * Provides few-shot examples from a Vertex AI Example Store.
 *
 * Examples are fetched per request, so a curated store can be updated without
 * redeploying the agent.
 *
 * Pass the provider to an {@link ExampleTool} to prepend the fetched examples
 * to the agent's system instruction.
 *
 * @example
 * ```ts
 * const store = new VertexAiExampleStore({
 *   examplesStoreName:
 *     'projects/my-project/locations/us-central1/exampleStores/my-store',
 * });
 * const agent = new LlmAgent({
 *   name: 'support_agent',
 *   model: 'gemini-2.0-flash',
 *   tools: [new ExampleTool(store)],
 * });
 * ```
 */
@experimental
export class VertexAiExampleStore extends BaseExampleProvider {
  private readonly examplesStoreName: string;
  private readonly client: ExampleStoreClient;

  constructor(options: VertexAiExampleStoreOptions) {
    super();
    const match = EXAMPLE_STORE_NAME_PATTERN.exec(options.examplesStoreName);
    if (!match) {
      throw new Error(
        `Invalid examplesStoreName '${options.examplesStoreName}'. Expected ` +
          'format: projects/{project}/locations/{location}/exampleStores/' +
          '{example_store}.',
      );
    }
    this.examplesStoreName = options.examplesStoreName;
    this.client =
      options.client ?? new VertexAiExampleStoreRestClient(match[1]);
  }

  override async getExamples(query: string): Promise<Example[]> {
    const response = await this.client.searchExamples({
      exampleStore: this.examplesStoreName,
      topK: DEFAULT_TOP_K,
      storedContentsExampleParameters: {
        contentSearchKey: {
          contents: [createUserContent(query)],
          searchKeyGenerationMethod: {lastEntry: {}},
        },
      },
    });
    return (response.results ?? [])
      .filter((result) => (result.similarityScore ?? 0) >= MIN_SIMILARITY_SCORE)
      .map(toExample);
  }
}
