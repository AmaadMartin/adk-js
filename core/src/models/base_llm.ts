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

/** Class names already warned about, so the fallback warns once per subclass. */
const warnedNameBasedModels = new Set<string>();

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
   * List of supported models in regex for LlmRegistry.
   */
  static readonly supportedModels: Array<string | RegExp> = [];

  /**
   * The capabilities of this model instance.
   *
   * Subclasses override this to declare what they support. Build on the parent
   * snapshot with a spread, `{...super.capabilities, outputSchemaAndTools:
   * true}`, so a capability the override does not name keeps the parent's
   * value. A subclass that extends `BaseLlm` directly should declare every
   * field outright instead, because spreading `super.capabilities` routes
   * through the deprecated fallback below.
   *
   * Keep an override a plain getter rather than caching the result: a
   * capability may depend on state that changes after construction, such as an
   * environment variable or a reassigned `model`.
   */
  get capabilities(): LlmCapabilities {
    return {outputSchemaAndTools: this.legacyOutputSchemaAndTools()};
  }

  /**
   * Resolves `outputSchemaAndTools` from the model name.
   *
   * Warns once per subclass, and only when it grants the capability, because
   * those are the models whose behaviour changes when the fallback goes.
   *
   * @deprecated A model that does not override {@link BaseLlm.capabilities}
   * keeps resolving the way it did before capabilities existed. This fallback
   * is removed once such models declare the capability explicitly.
   */
  private legacyOutputSchemaAndTools(): boolean {
    if (!geminiOutputSchemaAndTools(this.model)) {
      return false;
    }
    const className = this.constructor.name;
    if (!warnedNameBasedModels.has(className)) {
      warnedNameBasedModels.add(className);
      logger.warn(
        `${className} relies on name-based detection of outputSchemaAndTools. ` +
          'Override BaseLlm.capabilities to declare it explicitly; this ' +
          'fallback will be removed in a future release.',
      );
    }
    return true;
  }

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
   * @param llmRequest LlmRequest, the request to send to the LLM.
   * @return A live connection to the LLM.
   */
  abstract connect(llmRequest: LlmRequest): Promise<BaseLlmConnection>;

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
