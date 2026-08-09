/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isGeminiModel} from './model_name.js';
import {getGoogleLlmVariant, GoogleLLMVariant} from './variant_utils.js';

/**
 * Returns whether the model can natively accept an output schema at the same
 * time as tools, which is strictly more reliable than the prompt-based
 * `set_model_response` workaround.
 *
 * The capability belongs to the Vertex AI backend rather than to a Gemini
 * generation, so a Gemini id that encodes no version qualifies too.
 *
 * @param modelString A simple or path-based model name.
 * @return True if the model supports an output schema alongside tools.
 */
export function canUseOutputSchemaWithTools(modelString: string): boolean {
  return (
    getGoogleLlmVariant() === GoogleLLMVariant.VERTEX_AI &&
    isGeminiModel(modelString)
  );
}
