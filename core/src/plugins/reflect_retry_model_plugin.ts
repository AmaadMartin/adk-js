/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FinishReason, Part, Schema, Type} from '@google/genai';

import {Context} from '../agents/context.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {FunctionTool} from '../tools/function_tool.js';
import {randomUUID} from '../utils/env_aware_utils.js';

import {BasePlugin} from './base_plugin.js';
import {
  REFLECT_AND_RETRY_RESPONSE_TYPE,
  resolveScopeKey,
  ScopedFailureTracker,
  TrackingScope,
} from './reflect_retry_utils.js';

/**
 * Error type used when the model directly calls the reserved reflection tool.
 */
export const RESERVED_TOOL_CALL_ERROR_TYPE = 'RESERVED_TOOL_CALL';

/**
 * Name of the reserved tool injected into every request so the framework can
 * feed reflection guidance back to the model.
 */
const ADK_HANDLE_MODEL_ERROR = 'adk_handle_model_error';

/**
 * Configuration options for {@link ReflectAndRetryModelPlugin}.
 */
export interface ReflectAndRetryModelPluginOptions {
  /** Plugin instance identifier. Defaults to `'reflect_retry_model_plugin'`. */
  name?: string;
  /**
   * Maximum consecutive failures before giving up (0 = no retries). Must be a
   * non-negative integer. Defaults to `3`.
   */
  maxRetries?: number;
  /**
   * If `true`, throws when the retry limit is exceeded; otherwise returns the
   * failing response. Defaults to `true`.
   */
  throwExceptionIfRetryExceeded?: boolean;
  /**
   * Determines the lifecycle of the failure-tracking state. Defaults to
   * {@link TrackingScope.INVOCATION}.
   */
  trackingScope?: TrackingScope;
  /**
   * Finish reasons treated as retryable model errors. Defaults to
   * `[FinishReason.MALFORMED_FUNCTION_CALL]`.
   */
  onModelErrors?: FinishReason[];
}

/**
 * Provides self-healing error recovery for model failures.
 *
 * This plugin injects a reserved reflection tool into every request, detects
 * model errors surfaced in the {@link LlmResponse} (by `finishReason`), and
 * feeds structured reflection guidance back to the model to drive a retry, up
 * to a configurable limit. Failure counts are tracked per-model-name within a
 * configurable scope; a successful response resets that model's counter.
 *
 * @example
 * ```typescript
 * import {ReflectAndRetryModelPlugin, TrackingScope} from '@google/adk';
 *
 * // Most common: retry malformed function calls up to 3x within an invocation.
 * const plugin = new ReflectAndRetryModelPlugin();
 *
 * // Track failures globally across invocations, allow 5 retries.
 * const globalPlugin = new ReflectAndRetryModelPlugin({
 *   maxRetries: 5,
 *   trackingScope: TrackingScope.GLOBAL,
 * });
 *
 * // Registered on the runner like any other plugin:
 * // new Runner({ ..., plugins: [plugin] });
 * ```
 */
export class ReflectAndRetryModelPlugin extends BasePlugin {
  readonly maxRetries: number;
  readonly throwExceptionIfRetryExceeded: boolean;
  readonly scope: TrackingScope;
  readonly onModelErrors: FinishReason[];
  private readonly tracker: ScopedFailureTracker;

  constructor(options: ReflectAndRetryModelPluginOptions = {}) {
    super(options.name ?? 'reflect_retry_model_plugin');
    const maxRetries = options.maxRetries ?? 3;
    if (maxRetries < 0) {
      throw new Error('max_retries must be a non-negative integer.');
    }
    this.maxRetries = maxRetries;
    this.throwExceptionIfRetryExceeded =
      options.throwExceptionIfRetryExceeded ?? true;
    this.scope = options.trackingScope ?? TrackingScope.INVOCATION;
    this.onModelErrors = this.validateModelErrors(
      options.onModelErrors ?? [FinishReason.MALFORMED_FUNCTION_CALL],
    );
    this.tracker = new ScopedFailureTracker();
  }

  /**
   * Injects the reserved reflection tool into the request so the model always
   * has a tool it can be driven to call for corrective guidance.
   */
  override async beforeModelCallback({
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    this.provideReflectionTool(llmRequest);
    return undefined;
  }

  /**
   * Detects a reserved tool (mis)call or a retryable model error and drives the
   * reflect-and-retry flow. On a successful response, resets the model's
   * failure counter.
   */
  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    if (this.hasReservedToolCall(llmResponse)) {
      return this.handleReservedToolCall({callbackContext});
    }

    if (this.checkForModelError(llmResponse)) {
      return this.handleModelError({callbackContext, llmResponse});
    }

    const scopeKey = this.getModelScopeKey(callbackContext);
    const modelName = this.getModelNameFromContext(callbackContext);
    await this.resetModelFailureCount(scopeKey, modelName);
    return undefined;
  }

  /**
   * The reserved reflection tool's implementation. Returns structured guidance
   * instructing the model to reflect on the failure and try a different
   * approach.
   */
  private adkHandleModelError(args: {retry_count?: number}): {
    reflection_guidance: string;
  } {
    const reflectionGuidance = `The call to the model failed.

**Reflection Guidance:**
- This is retry attempt **${args.retry_count}** of **${this.maxRetries}**
- Analyze the error and the arguments you provided. Do not repeat the exact same call.

Formulate a new plan based on your analysis and try a corrected or different approach.`;
    return {reflection_guidance: reflectionGuidance};
  }

  /**
   * Returns `true` when the response is a retryable model error: it carries an
   * `errorCode` and its `finishReason` is in the configured allow-list.
   */
  private checkForModelError(llmResponse: LlmResponse): boolean {
    if (!llmResponse.errorCode) {
      return false;
    }
    return (
      llmResponse.finishReason !== undefined &&
      this.onModelErrors.includes(llmResponse.finishReason)
    );
  }

  /**
   * Validates that every entry in `modelErrors` is a {@link FinishReason}.
   */
  private validateModelErrors(modelErrors: FinishReason[]): FinishReason[] {
    const validReasons = Object.values(FinishReason);
    for (const modelError of modelErrors) {
      if (!validReasons.includes(modelError)) {
        throw new Error(
          `model_error must be a FinishReason, got ${modelError}`,
        );
      }
    }
    return modelErrors;
  }

  /**
   * Resolves the current model name from the callback context.
   */
  private getModelNameFromContext(callbackContext: Context): string {
    const agent = callbackContext.invocationContext.agent;
    if (isLlmAgent(agent)) {
      // `canonicalModel` is a getter that throws when no model is resolvable;
      // guard it so callers observe the intended error below.
      try {
        const model = agent.canonicalModel?.model;
        if (model) {
          return model;
        }
      } catch {
        // Fall through to the thrown error below.
      }
    }
    throw new Error('Agent model not found.');
  }

  /**
   * Adds the reserved reflection tool to the request's tools dictionary.
   */
  private provideReflectionTool(llmRequest: LlmRequest): void {
    const parameters: Schema = {
      type: Type.OBJECT,
      properties: {
        response_type: {type: Type.STRING},
        error_type: {type: Type.STRING},
        error_details: {type: Type.STRING},
        finish_reason: {type: Type.STRING},
        retry_count: {type: Type.INTEGER},
      },
    };
    llmRequest.toolsDict[ADK_HANDLE_MODEL_ERROR] = new FunctionTool({
      name: ADK_HANDLE_MODEL_ERROR,
      description:
        'A tool that triggers reflection. Reserved for internal framework ' +
        'use only. Do not call directly.',
      parameters,
      execute: (args) =>
        this.adkHandleModelError(args as {retry_count?: number}),
    });
  }

  /**
   * Returns `true` when the response contains a function call to the reserved
   * reflection tool.
   */
  private hasReservedToolCall(llmResponse: LlmResponse): boolean {
    for (const part of llmResponse.content?.parts ?? []) {
      if (part.functionCall?.name === ADK_HANDLE_MODEL_ERROR) {
        return true;
      }
    }
    return false;
  }

  /**
   * Handles the model directly (mis)calling the reserved reflection tool.
   */
  private async handleReservedToolCall({
    callbackContext,
  }: {
    callbackContext: Context;
  }): Promise<LlmResponse> {
    const response = await this.handleModelRetry({
      callbackContext,
      errorType: RESERVED_TOOL_CALL_ERROR_TYPE,
      errorDetails:
        `Model attempted to call reserved tool ${ADK_HANDLE_MODEL_ERROR} ` +
        'directly. This tool is reserved for framework use only. Do not ' +
        'call it.',
      finishReason: FinishReason.OTHER,
    });
    if (response) {
      return response;
    }
    return {
      errorCode: RESERVED_TOOL_CALL_ERROR_TYPE,
      errorMessage:
        'Model attempted to call reserved tool and retry limit was exceeded.',
    };
  }

  /**
   * Handles a retryable model error surfaced in the response.
   */
  private async handleModelError({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse> {
    const response = await this.handleModelRetry({
      callbackContext,
      // Non-null: this path is only reached after checkForModelError confirmed
      // errorCode is set.
      errorType: llmResponse.errorCode!,
      errorDetails: llmResponse.errorMessage,
      finishReason: llmResponse.finishReason,
    });
    return response ?? llmResponse;
  }

  /**
   * Central retry logic: increments the failure counter and either returns a
   * synthesized retry response, throws, or returns `undefined` when the limit
   * is exceeded (depending on `throwExceptionIfRetryExceeded`).
   */
  private async handleModelRetry({
    callbackContext,
    errorType,
    errorDetails,
    finishReason,
  }: {
    callbackContext: Context;
    errorType: string;
    errorDetails: string | undefined;
    finishReason: FinishReason | undefined;
  }): Promise<LlmResponse | undefined> {
    const scopeKey = this.getModelScopeKey(callbackContext);
    const modelName = this.getModelNameFromContext(callbackContext);
    const currentRetries = await this.incrementModelFailureCount(
      scopeKey,
      modelName,
    );

    if (currentRetries <= this.maxRetries) {
      return {
        content: {
          role: 'model',
          parts: [
            this.generateModelRetryPart({
              retryCount: currentRetries,
              errorType,
              errorDetails,
              finishReason,
            }),
          ],
        },
      };
    }

    if (this.throwExceptionIfRetryExceeded) {
      throw new Error(
        `The model has failed consecutively ${this.maxRetries} times and ` +
          'the retry limit has been exceeded.',
      );
    }
    return undefined;
  }

  /**
   * Builds the synthesized `functionCall` part that carries reflection metadata
   * back to the model.
   */
  private generateModelRetryPart({
    retryCount,
    errorType,
    errorDetails,
    finishReason,
  }: {
    retryCount: number;
    errorType: string;
    errorDetails: string | undefined;
    finishReason: FinishReason | undefined;
  }): Part {
    return {
      functionCall: {
        id: this.getModelRetryUuid(),
        name: ADK_HANDLE_MODEL_ERROR,
        args: {
          response_type: REFLECT_AND_RETRY_RESPONSE_TYPE,
          error_type: errorType,
          error_details: errorDetails,
          finish_reason: finishReason,
          retry_count: retryCount,
        },
      },
    };
  }

  private getModelRetryUuid(): string {
    return `${ADK_HANDLE_MODEL_ERROR}_${randomUUID()}`;
  }

  private getModelScopeKey(callbackContext: Context): string {
    return resolveScopeKey(
      this.scope,
      callbackContext.invocationContext.invocationId,
    );
  }

  private incrementModelFailureCount(
    scopeKey: string,
    itemName: string,
  ): Promise<number> {
    return this.tracker.increment(scopeKey, itemName);
  }

  private resetModelFailureCount(
    scopeKey: string,
    itemName: string,
  ): Promise<void> {
    return this.tracker.reset(scopeKey, itemName);
  }
}
