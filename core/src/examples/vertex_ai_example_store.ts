/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  createPartFromFunctionCall,
  createPartFromText,
  createUserContent,
  Part,
} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';

import {experimental} from '../utils/experimental.js';
import {BaseExampleProvider} from './base_example_provider.js';
import {Example} from './example.js';

/** Number of nearest examples requested per search, matching adk-python. */
const TOP_K = 10;

/** Results scoring below this are dropped, matching adk-python. */
const MIN_SIMILARITY_SCORE = 0.5;

/**
 * Matches a store resource name and captures its location.
 *
 * The location reaches the request host, so it is restricted to the characters
 * a region name uses. Excluding `/` alone would not be enough: `?`, `#` and `@`
 * each relocate the authority, which would send the credentialed search to
 * another origin.
 */
const EXAMPLE_STORE_NAME_PATTERN =
  /^projects\/[a-zA-Z0-9_-]+\/locations\/([a-z0-9-]+)\/exampleStores\/[a-zA-Z0-9_-]+$/;

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Returns the Vertex AI host serving a location.
 *
 * Every region prefixes the host, but `global` is served by the bare host, so
 * prefixing it would address a name that does not resolve. `@google/genai`
 * splits the two the same way.
 */
function toSearchHost(location: string): string {
  return location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;
}

/**
 * A single scored result returned by `searchExamples`.
 *
 * Every field is optional: proto3 JSON omits unset fields, and an unset nested
 * message is omitted whole. `example` also holds a oneof, so a variant this
 * provider does not read leaves `storedContentsExample` absent.
 */
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

/**
 * Narrows a stored part to the kinds the Example Store round-trips: text,
 * function calls and function responses. Any other kind is dropped.
 */
function toPart(part: Part): Part | undefined {
  if (part.text) {
    return createPartFromText(part.text);
  }
  if (part.functionCall) {
    return createPartFromFunctionCall(part.functionCall.name ?? '', {
      ...part.functionCall.args,
    });
  }
  if (part.functionResponse) {
    // Not createPartFromFunctionResponse: that also stamps an `id`, which
    // convertExamplesToText would render into the prompt.
    return {
      functionResponse: {
        name: part.functionResponse.name,
        response: {...part.functionResponse.response},
      },
    };
  }
  return undefined;
}

function toExample(result: SimilarExample): Example {
  const stored = result.example?.storedContentsExample;
  return {
    input: createUserContent(stored?.searchKey ?? ''),
    output: (stored?.contentsExample?.expectedContents ?? []).map(
      ({content}) => ({
        role: content?.role,
        parts: (content?.parts ?? []).flatMap((part) => toPart(part) ?? []),
      }),
    ),
  };
}

/**
 * Provides few-shot examples from a Vertex AI Example Store.
 *
 * Examples are fetched per request, so a curated store can be updated without
 * redeploying the agent.
 *
 * Pass the provider to an {@link ExampleTool} to prepend the fetched examples
 * to the agent's system instruction. The search runs with Application Default
 * Credentials and needs the `aiplatform.exampleStores.readExample` permission.
 *
 * @example
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'support_agent',
 *   model: 'gemini-2.0-flash',
 *   tools: [
 *     new ExampleTool(
 *       new VertexAiExampleStore(
 *         'projects/my-project/locations/us-central1/exampleStores/my-store',
 *       ),
 *     ),
 *   ],
 * });
 * ```
 */
@experimental
export class VertexAiExampleStore extends BaseExampleProvider {
  private readonly auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  private readonly searchUrl: string;

  /**
   * @param examplesStoreName The resource name of the Vertex AI Example Store,
   *   in the format
   *   `projects/{project}/locations/{location}/exampleStores/{example_store}`.
   *   The location is read from it to address the regional endpoint, so a
   *   malformed name throws here rather than on the first turn.
   */
  constructor(readonly examplesStoreName: string) {
    super();
    const match = EXAMPLE_STORE_NAME_PATTERN.exec(examplesStoreName);
    if (!match) {
      throw new Error(
        `Invalid examplesStoreName '${examplesStoreName}'. Expected format: ` +
          'projects/{project}/locations/{location}/exampleStores/' +
          '{example_store}.',
      );
    }
    this.searchUrl =
      `https://${toSearchHost(match[1])}/v1beta1/` +
      `${examplesStoreName}:searchExamples`;
  }

  override async getExamples(query: string): Promise<Example[]> {
    // The store name is bound to the URL path, so the body leaves it out.
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
    return (data.results ?? [])
      .filter((result) => (result.similarityScore ?? 0) >= MIN_SIMILARITY_SCORE)
      .map(toExample);
  }
}
