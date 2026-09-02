/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  GroundingSupport,
  LiveServerContent,
  LiveServerMessage,
  Part,
  UsageMetadata,
} from '@google/genai';
import {InteractionStatus, LlmResponse} from '../models/llm_response.js';
import {logger} from './logger.js';
import {isGemini3xLive} from './model_name.js';

/**
 * `LiveServerContent` plus the fields `@google/genai@2.9.0` does not declare
 * yet. The live API sends `interactionStatus` on the wire.
 */
export interface LiveServerContentWithStatus extends LiveServerContent {
  interactionStatus?: InteractionStatus;
}

/**
 * Grounding fields whose values accumulate as a set of strings across the
 * messages of one turn.
 */
const GROUNDING_STRING_LIST_FIELDS = [
  'imageSearchQueries',
  'retrievalQueries',
  'webSearchQueries',
] as const;

/**
 * Copies a support with its chunk indices moved past the chunks already
 * accumulated.
 */
function shiftChunkIndices(
  support: GroundingSupport,
  chunkOffset: number,
): GroundingSupport {
  if (!support.groundingChunkIndices?.length) {
    return support;
  }
  return {
    ...support,
    groundingChunkIndices: support.groundingChunkIndices.map(
      (index) => index + chunkOffset,
    ),
  };
}

/**
 * Merges the grounding metadata of one message into the metadata accumulated
 * for the turn so far.
 *
 * The live API sends grounding metadata in fragments: each message carries
 * only the queries, chunks and supports it added. Overwriting therefore loses
 * everything the earlier messages reported. A support indexes into the chunk
 * list of its own message, so its indices move past the chunks already
 * accumulated. Every other field takes the incoming value.
 *
 * Neither argument is modified, nested supports included.
 *
 * @param existing The metadata accumulated so far, if any.
 * @param incoming The metadata of the current message.
 * @returns The merged metadata.
 */
function mergeGroundingMetadata(
  existing: GroundingMetadata | undefined,
  incoming: GroundingMetadata,
): GroundingMetadata {
  if (!existing) {
    return incoming;
  }

  const chunkOffset = existing.groundingChunks?.length ?? 0;
  const merged: GroundingMetadata = {...existing, ...incoming};

  for (const field of GROUNDING_STRING_LIST_FIELDS) {
    const values = incoming[field];
    if (values !== undefined) {
      merged[field] = [...new Set([...(existing[field] ?? []), ...values])];
    }
  }
  if (incoming.groundingChunks !== undefined) {
    merged.groundingChunks = [
      ...(existing.groundingChunks ?? []),
      ...incoming.groundingChunks,
    ];
  }
  if (incoming.groundingSupports !== undefined) {
    merged.groundingSupports = [
      ...(existing.groundingSupports ?? []),
      ...incoming.groundingSupports.map((support) =>
        shiftChunkIndices(support, chunkOffset),
      ),
    ];
  }
  return merged;
}

/**
 * Converts live API usage metadata to `GenerateContentResponse` usage
 * metadata.
 *
 * The live API names output tokens `responseTokenCount` /
 * `responseTokensDetails`, whereas `GenerateContentResponseUsageMetadata`
 * names them `candidatesTokenCount` / `candidatesTokensDetails`. Passing the
 * live object through unchanged therefore leaves a caller reading either
 * `candidates` field with `undefined`.
 *
 * `serviceTier` has no counterpart on the target type and is dropped.
 *
 * @param usageMetadata The live API usage metadata.
 * @returns The converted usage metadata.
 */
function toGenerateContentUsageMetadata(
  usageMetadata: UsageMetadata,
): GenerateContentResponseUsageMetadata {
  return {
    promptTokenCount: usageMetadata.promptTokenCount,
    cachedContentTokenCount: usageMetadata.cachedContentTokenCount,
    candidatesTokenCount: usageMetadata.responseTokenCount,
    totalTokenCount: usageMetadata.totalTokenCount,
    thoughtsTokenCount: usageMetadata.thoughtsTokenCount,
    toolUsePromptTokenCount: usageMetadata.toolUsePromptTokenCount,
    promptTokensDetails: usageMetadata.promptTokensDetails,
    cacheTokensDetails: usageMetadata.cacheTokensDetails,
    candidatesTokensDetails: usageMetadata.responseTokensDetails,
    toolUsePromptTokensDetails: usageMetadata.toolUsePromptTokensDetails,
    trafficType: usageMetadata.trafficType,
  };
}

/**
 * Warns when the backend reported search queries but no chunks to attribute
 * them to, which makes the grounding unusable for the caller.
 */
function warnOnIncompleteGrounding(
  groundingMetadata: GroundingMetadata | undefined,
): void {
  if (
    groundingMetadata?.retrievalQueries?.length &&
    !groundingMetadata.groundingChunks?.length
  ) {
    logger.warn(
      'Incomplete groundingMetadata received: groundingChunks is empty for' +
        ` retrievalQueries=${JSON.stringify(groundingMetadata.retrievalQueries)}.` +
        ' This may indicate a transient issue with the Vertex AI Search backend.',
    );
  }
}

/**
 * Aggregator and mapper for Gemini Live WebSocket server messages.
 *
 * Translates incoming raw WebSocket server messages (push stream) into unified
 * agent-consumable LlmResponse objects (pull stream), managing transcription buffers,
 * grounding metadata, text segments, and tool calls.
 */
export class LiveResponseAggregator {
  private text = '';
  private isThought = false;
  private toolCallParts: Part[] = [];
  private pendingGroundingMetadata: GroundingMetadata | undefined = undefined;
  private toolCallGroundingMetadata: GroundingMetadata | undefined = undefined;
  private inputTranscriptionText = '';
  private outputTranscriptionText = '';
  private readonly isGemini3xLive: boolean;

  constructor(private readonly modelVersion?: string) {
    this.isGemini3xLive = isGemini3xLive(modelVersion);
  }

  *processMessage(
    message: LiveServerMessage,
  ): Generator<LlmResponse, void, void> {
    if (message.usageMetadata) {
      yield {
        usageMetadata: toGenerateContentUsageMetadata(message.usageMetadata),
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
    }

    if (message.serverContent) {
      const serverContent: LiveServerContentWithStatus = message.serverContent;
      const content = serverContent.modelTurn;
      const turnCompleteReason = serverContent.turnCompleteReason;

      if (serverContent.groundingMetadata) {
        this.pendingGroundingMetadata = mergeGroundingMetadata(
          this.pendingGroundingMetadata,
          serverContent.groundingMetadata,
        );
      }

      // Standalone groundingMetadata event (when content is empty)
      if (
        !(content && content.parts) &&
        serverContent.groundingMetadata &&
        !serverContent.turnComplete
      ) {
        yield {
          groundingMetadata: serverContent.groundingMetadata,
          ...(serverContent.interrupted !== undefined
            ? {interrupted: serverContent.interrupted}
            : {}),
          ...(turnCompleteReason ? {turnCompleteReason} : {}),
          ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
        };
      }

      if (content && content.parts) {
        const llmResponse: LlmResponse = {
          content: content as Content,
          ...(serverContent.interrupted !== undefined
            ? {interrupted: serverContent.interrupted}
            : {}),
          ...(turnCompleteReason ? {turnCompleteReason} : {}),
          ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
        };

        if (!serverContent.turnComplete && serverContent.groundingMetadata) {
          llmResponse.groundingMetadata = serverContent.groundingMetadata;
        }

        const hasInlineData = content.parts.some((p) => p.inlineData);
        for (const part of content.parts) {
          if (part.text) {
            const currentIsThought = !!part.thought;
            if (this.text && currentIsThought !== this.isThought) {
              yield this.buildFullTextResponse(this.text, this.isThought);
              this.text = '';
              this.isThought = false;
            }
            this.text += part.text;
            this.isThought = currentIsThought;
            llmResponse.partial = true;
          }
        }

        // don't yield the merged text event when receiving audio data
        if (this.text && !content.parts.some((p) => p.text) && !hasInlineData) {
          yield this.buildFullTextResponse(
            this.text,
            this.isThought,
            this.pendingGroundingMetadata,
          );
          this.text = '';
          this.isThought = false;
          this.pendingGroundingMetadata = undefined;
        }

        yield llmResponse;
      }

      if (serverContent.inputTranscription) {
        const {text, finished} = serverContent.inputTranscription;
        if (this.isGemini3xLive) {
          // Gemini 3.x Live sends one final input transcription rather than a
          // stream of partials, so there is nothing to accumulate.
          if (text) {
            yield {
              inputTranscription: {text, finished: true},
              partial: false,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
          }
        } else {
          if (text) {
            this.inputTranscriptionText += text;
            yield {
              inputTranscription: {text, finished: false},
              partial: true,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
          }
          if (finished) {
            yield {
              inputTranscription: {
                text: this.inputTranscriptionText,
                finished: true,
              },
              partial: false,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
            this.inputTranscriptionText = '';
          }
        }
      }

      if (serverContent.outputTranscription) {
        if (serverContent.outputTranscription.text) {
          this.outputTranscriptionText +=
            serverContent.outputTranscription.text;
          yield {
            outputTranscription: {
              text: serverContent.outputTranscription.text,
              finished: false,
            },
            partial: true,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
        }
        if (serverContent.outputTranscription.finished) {
          yield {
            outputTranscription: {
              text: this.outputTranscriptionText,
              finished: true,
            },
            partial: false,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          this.outputTranscriptionText = '';
        }
      }

      if (
        serverContent.interrupted ||
        serverContent.turnComplete ||
        serverContent.generationComplete
      ) {
        if (this.inputTranscriptionText) {
          yield {
            inputTranscription: {
              text: this.inputTranscriptionText,
              finished: true,
            },
            partial: false,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          this.inputTranscriptionText = '';
        }
        if (this.outputTranscriptionText) {
          yield {
            outputTranscription: {
              text: this.outputTranscriptionText,
              finished: true,
            },
            partial: false,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          this.outputTranscriptionText = '';
        }
      }

      if (serverContent.turnComplete) {
        warnOnIncompleteGrounding(
          this.finalGroundingMetadata(serverContent.groundingMetadata),
        );
        if (this.text) {
          yield this.buildFullTextResponse(
            this.text,
            this.isThought,
            this.pendingGroundingMetadata,
            !!serverContent.interrupted,
          );
          this.text = '';
          this.isThought = false;
          this.pendingGroundingMetadata = undefined;
        }
        if (this.toolCallParts.length > 0) {
          yield {
            content: {role: 'model', parts: this.toolCallParts},
            ...(this.toolCallGroundingMetadata
              ? {groundingMetadata: this.toolCallGroundingMetadata}
              : {}),
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          this.toolCallParts = [];
          if (this.toolCallGroundingMetadata !== undefined) {
            this.pendingGroundingMetadata = undefined;
          }
          this.toolCallGroundingMetadata = undefined;
        }
        const finalResponse: LlmResponse = {
          turnComplete: true,
          ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
        };
        if (serverContent.interrupted !== undefined) {
          finalResponse.interrupted = serverContent.interrupted;
        }
        const finalGrounding = this.finalGroundingMetadata(
          serverContent.groundingMetadata,
        );
        if (finalGrounding !== undefined) {
          finalResponse.groundingMetadata = finalGrounding;
        }
        if (turnCompleteReason) {
          finalResponse.turnCompleteReason = turnCompleteReason;
        }
        if (serverContent.interactionStatus) {
          finalResponse.interactionStatus = serverContent.interactionStatus;
        }
        yield finalResponse;
        this.pendingGroundingMetadata = undefined;
      }

      if (serverContent.interrupted) {
        if (this.text) {
          yield this.buildFullTextResponse(
            this.text,
            this.isThought,
            this.pendingGroundingMetadata,
            true,
          );
          this.text = '';
          this.isThought = false;
        } else {
          yield {
            interrupted: serverContent.interrupted,
            ...(this.pendingGroundingMetadata
              ? {groundingMetadata: this.pendingGroundingMetadata}
              : {}),
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
        }
        this.pendingGroundingMetadata = undefined;
      }
    }

    if (message.toolCall) {
      if (this.text) {
        yield this.buildFullTextResponse(
          this.text,
          this.isThought,
          this.pendingGroundingMetadata,
        );
        this.text = '';
        this.isThought = false;
        this.pendingGroundingMetadata = undefined;
      }
      if (message.toolCall.functionCalls) {
        this.toolCallParts.push(
          ...message.toolCall.functionCalls.map((fc) => ({
            functionCall: fc,
          })),
        );
      }

      // Gemini 3.x Live does not emit turnComplete until it receives the tool
      // response, so yield tool calls immediately to avoid deadlocking the
      // conversation. Other models send turnComplete after tool calls, so
      // buffer and merge them into a single response at turnComplete.
      if (!this.isGemini3xLive) {
        this.toolCallGroundingMetadata ??= this.pendingGroundingMetadata;
      } else if (this.toolCallParts.length > 0) {
        yield {
          content: {role: 'model', parts: this.toolCallParts},
          ...(this.pendingGroundingMetadata
            ? {groundingMetadata: this.pendingGroundingMetadata}
            : {}),
          ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
        };
        this.toolCallParts = [];
        this.pendingGroundingMetadata = undefined;
      }
    }

    if (message.sessionResumptionUpdate) {
      yield {
        liveSessionResumptionUpdate: message.sessionResumptionUpdate,
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
    }

    if (message.voiceActivity) {
      yield {
        voiceActivity: message.voiceActivity,
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
    }

    if (message.goAway) {
      yield {
        goAway: message.goAway,
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
    }
  }

  /**
   * Flushes any remaining aggregated components when the connection is closed.
   */
  *close(): Generator<LlmResponse, void, void> {
    if (this.toolCallParts.length > 0) {
      yield {
        content: {role: 'model', parts: this.toolCallParts},
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
      this.toolCallParts = [];
    }
  }

  /**
   * Resolves the grounding metadata that closes the turn.
   *
   * The current message wins over the metadata accumulated for the turn.
   * Gemini 3.x Live reports an empty object when it grounded nothing, so that
   * a caller can tell "no grounding" from "grounding not supported".
   */
  private finalGroundingMetadata(
    messageGroundingMetadata: GroundingMetadata | undefined,
  ): GroundingMetadata | undefined {
    return (
      messageGroundingMetadata ??
      this.pendingGroundingMetadata ??
      (this.isGemini3xLive ? {} : undefined)
    );
  }

  private buildFullTextResponse(
    text: string,
    isThought: boolean,
    groundingMetadata?: GroundingMetadata,
    interrupted = false,
  ): LlmResponse {
    const part: Part = {text};
    if (isThought) {
      part.thought = true;
    }
    const response: LlmResponse = {
      content: {
        role: 'model',
        parts: [part],
      },
      partial: false,
    };
    if (groundingMetadata !== undefined && groundingMetadata !== null) {
      response.groundingMetadata = groundingMetadata;
    }
    if (interrupted) {
      response.interrupted = true;
    }
    if (this.modelVersion) {
      response.modelVersion = this.modelVersion;
    }
    return response;
  }
}
