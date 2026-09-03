/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI} from '@google/genai';
import {formatError} from '../../utils/error_utils.js';

/**
 * Embeds text with a Vertex AI embedding model, for the search paths that
 * generate the query vector on the client rather than inside Spanner.
 */

/**
 * Embeds one text with a Vertex AI embedding model.
 *
 * The client reads its project, location and credentials from the
 * environment, as adk-python's `genai.Client()` does.
 *
 * @param modelName The embedding model, e.g. `text-embedding-005`.
 * @param content The text to embed.
 * @param outputDimensionality The vector length to ask the model for.
 * @return The embedding vector.
 * @throws Error if the request fails or the response carries no vector.
 */
export async function embedContent(
  modelName: string,
  content: string,
  outputDimensionality?: number,
): Promise<number[]> {
  try {
    const client = new GoogleGenAI({});
    const response = await client.models.embedContent({
      model: modelName,
      contents: [content],
      config: outputDimensionality ? {outputDimensionality} : {},
    });
    const values = response.embeddings?.[0]?.values;
    if (!values) {
      throw new Error('the response carried no embedding.');
    }
    return values;
  } catch (err: unknown) {
    throw new Error(`Failed to embed content: ${formatError(err)}`);
  }
}
