/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getClientLabels} from '../utils/client_labels.js';
import {logger} from '../utils/logger.js';
import {geminiOutputSchemaAndTools} from '../utils/output_schema_utils.js';

import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmCapabilities} from './capabilities.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * A unique symbol to identify BaseLlm classes.
 * Defined once and shared by all BaseLlm instances.
 */
const BASE_MODEL_SYMBOL = Symbol.for('google.adk.baseModel');

/** Subclasses already told to migrate, so the notice is logged once each. */
const warnedNameBasedModels = new WeakSet<object>();

/**
 * Type guard to check if an object is an instance of BaseLlm.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseLlm, false otherwise.
 */
export function isBaseLlm(obj: unknown): obj is BaseLlm {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_MODEL_SYMBOL in obj &&
    obj[BASE_MODEL_SYMBOL] === true
  );
}

/**
 * The BaseLLM class.
 */
export abstract class BaseLlm {
  /**
   * A unique symbol to identify BaseLlm classes.
   */
  readonly [BASE_MODEL_SYMBOL] = true;

  readonly model: string;

  /**
   * Creates an instance of BaseLLM.
   * @param params The parameters for creating a BaseLlm instance.
   * @param params.model The name of the LLM, e.g. gemini-1.5-flash or
   *     gemini-1.5-flash-001.
   */
  constructor({model}: {model: string}) {
    this.model = model;
  }

  /**
   * The capabilities of this model instance, recomputed on every access.
   *
   * Subclasses override this to declare what they support, so that callers ask
   * the model instead of deriving support from its name. Declare every field
   * when extending `BaseLlm` directly: spreading `super.capabilities` there
   * routes through the deprecated name-based fallback below.
   *
   * ```ts
   * class MyGemini extends Gemini {
   *   override get capabilities(): LlmCapabilities {
   *     return {...super.capabilities, outputSchemaAndTools: true};
   *   }
   * }
   * ```
   *
   * @return A fresh snapshot of the resolved capabilities.
   */
  get capabilities(): LlmCapabilities {
    return {outputSchemaAndTools: this.legacyOutputSchemaAndTools()};
  }

  /**
   * Name-based fallback for models that do not report the capability.
   *
   * The warning fires only when the fallback grants the capability, because
   * those are the only models whose behavior changes once it is removed.
   * `Gemini` declares {@link capabilities} outright and never reaches it.
   *
   * @deprecated It exists so that a model defined outside ADK keeps resolving
   * the way it did before {@link capabilities}, when support was inferred from
   * the model name rather than declared by the model. It is removed once such
   * models declare the capability explicitly.
   *
   * @return True if the model name grants an output schema alongside tools.
   */
  private legacyOutputSchemaAndTools(): boolean {
    if (!geminiOutputSchemaAndTools(this.model)) {
      return false;
    }
    if (!warnedNameBasedModels.has(this.constructor)) {
      warnedNameBasedModels.add(this.constructor);
      logger.warn(
        `${this.constructor.name} relies on name-based detection of ` +
          'outputSchemaAndTools. Override BaseLlm.capabilities to declare it ' +
          'explicitly; this fallback will be removed in a future release.',
      );
    }
    return true;
  }

  /**
   * List of supported models in regex for LlmRegistry.
   */
  static readonly supportedModels: Array<string | RegExp> = [];

  /**
   * Generates one content from the given contents and tools.
   *
   * @param llmRequest  LlmRequest, the request to send to the LLM.
   * @param stream whether to do streaming call.
   * For non-streaming call, it will only yield one Content.
   * @return A generator of LlmResponse.
   */
  abstract generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void>;

  /**
   * Creates a live connection to the LLM.
   *
   * Subclasses that support bidirectional streaming override this. The base
   * implementation rejects.
   *
   * @param _llmRequest LlmRequest, the request to send to the LLM; unused by
   * the base implementation.
   * @return A live connection to the LLM.
   */
  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }

  protected get trackingHeaders(): Record<string, string> {
    const labels = getClientLabels();
    const headerValue = labels.join(' ');
    return {
      'x-goog-api-client': headerValue,
      'user-agent': headerValue,
    };
  }

  /**
   * Appends a user content, so that model can continue to output.
   *
   * @param llmRequest LlmRequest, the request to send to the LLM.
   */
  maybeAppendUserContent(llmRequest: LlmRequest): void {
    if (llmRequest.contents.length === 0) {
      llmRequest.contents.push({
        role: 'user',
        parts: [
          {
            text: 'Handle the requests as specified in the System Instruction.',
          },
        ],
      });
    }

    if (llmRequest.contents[llmRequest.contents.length - 1]?.role !== 'user') {
      llmRequest.contents.push({
        role: 'user',
        parts: [
          {
            text: 'Continue processing previous requests as instructed. Exit or provide a summary if no more outputs are needed.',
          },
        ],
      });
    }
  }
}
