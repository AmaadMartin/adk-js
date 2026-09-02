/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isGemini2OrAbove} from './model_name.js';
import {getGoogleLlmVariant, GoogleLLMVariant} from './variant_utils.js';

/**
 * Returns whether a Gemini model id can natively accept an output schema at
 * the same time as tools, which is strictly more reliable than the
 * prompt-based `set_model_response` workaround.
 *
 * Read `model.capabilities.outputSchemaAndTools` instead whenever a model
 * instance is in hand, because a subclass may declare a capability that no
 * model name reveals.
 *
 * Early Access Program model names encode no numeric version, so
 * `isGemini2OrAbove` rejects them even on Vertex AI. The Python
 * implementation accepts them; that gap lives in the shared predicate.
 *
 * @param modelString A simple or path-based model name.
 * @return True if the model supports an output schema alongside tools.
 */
export function geminiOutputSchemaAndTools(modelString: string): boolean {
  return (
    getGoogleLlmVariant() === GoogleLLMVariant.VERTEX_AI &&
    isGemini2OrAbove(modelString)
  );
}
