/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A stand-in for the `GoogleGenAI` client the Vertex AI embedding path uses.
 *
 * It imports nothing from `@google/adk`: the `vi.mock('@google/genai', ...)`
 * factory awaits this module, and an ADK import there would deadlock on the
 * very module being mocked.
 */
/** One `embedContent` call the Vertex AI embedding path made. */
export interface RecordedEmbedCall {
  model: string;
  contents: unknown;
  config: unknown;
}

/** What the GenAI stand-in answers with, and what it recorded. */
export interface GenaiFake {
  /** The embedding returned, or `undefined` to return none. */
  embedding?: number[];
  /** Thrown instead of embedding. */
  error?: Error;
  calls: RecordedEmbedCall[];
  clientOptions: Array<Record<string, unknown>>;
}

/** The scripted state shared by the GenAI stand-in and the test. */
export const genaiFake: GenaiFake = newGenaiFake();

function newGenaiFake(): GenaiFake {
  return {
    embedding: [0.1, 0.2, 0.3],
    error: undefined,
    calls: [],
    clientOptions: [],
  };
}

/** Clears the scripted embedding and the recorded calls, for `beforeEach`. */
export function resetGenaiFake(): void {
  Object.assign(genaiFake, newGenaiFake());
}

/** The subset of `GoogleGenAI` the Vertex AI embedding path uses. */
export class FakeGoogleGenAI {
  readonly models = {
    embedContent: async (params: RecordedEmbedCall) => {
      genaiFake.calls.push(params);
      if (genaiFake.error) {
        throw genaiFake.error;
      }
      return {
        embeddings: genaiFake.embedding
          ? [{values: genaiFake.embedding}]
          : undefined,
      };
    },
  };

  constructor(options: Record<string, unknown>) {
    genaiFake.clientOptions.push(options);
  }
}
