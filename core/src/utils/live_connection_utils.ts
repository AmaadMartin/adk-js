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
  LiveServerToolCall,
  Part,
  Transcription,
  UsageMetadata,
} from '@google/genai';
import {InteractionStatus, LlmResponse} from '../models/llm_response.js';
import {logger} from './logger.js';
import {isGemini3xLive} from './model_name.js';

/** The `GroundingMetadata` fields that hold a list of strings. */
const GROUNDING_QUERY_FIELDS = [
  'imageSearchQueries',
  'retrievalQueries',
  'webSearchQueries',
] as const;

/**
 * `LiveServerContent` with the activity state the live API reports alongside
 * `turnComplete`. `@google/genai` 2.9.0 does not declare the field yet, so the
 * aggregator reads it through this extension rather than dropping it.
 */
interface LiveServerContentWithInteractionStatus extends LiveServerContent {
  interactionStatus?: InteractionStatus;
}

function readInteractionStatus(
  serverContent: LiveServerContent,
): InteractionStatus | undefined {
  return (serverContent as LiveServerContentWithInteractionStatus)
    .interactionStatus;
}

/** Appends the strings that the existing list does not hold yet. */
function unionStrings(
  existing: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  if (!incoming) {
    return existing;
  }
  const merged = existing ? [...existing] : [];
  for (const item of incoming) {
    if (!merged.includes(item)) {
      merged.push(item);
    }
  }
  return merged;
}

/** Renumbers the chunk indices of appended supports onto the merged chunks. */
function shiftGroundingSupports(
  supports: GroundingSupport[],
  chunkOffset: number,
): GroundingSupport[] {
  return supports.map((support) =>
    support.groundingChunkIndices?.length
      ? {
          ...support,
          groundingChunkIndices: support.groundingChunkIndices.map(
            (index) => index + chunkOffset,
          ),
        }
      : support,
  );
}

/**
 * Accumulates the grounding metadata of one turn.
 *
 * The live API reports grounding across several messages, each carrying only
 * its own chunks. Keeping the last message's metadata alone loses the earlier
 * citations, so queries are unioned, chunks are concatenated, and the appended
 * supports are renumbered onto the concatenated chunks. Every other field takes
 * the incoming value.
 */
function mergeGroundingMetadata(
  existing: GroundingMetadata | undefined,
  incoming: GroundingMetadata | undefined,
): GroundingMetadata | undefined {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  const chunkOffset = existing.groundingChunks?.length ?? 0;
  const merged: GroundingMetadata = {...existing, ...incoming};
  for (const field of GROUNDING_QUERY_FIELDS) {
    const queries = unionStrings(existing[field], incoming[field]);
    if (queries) {
      merged[field] = queries;
    }
  }
  if (incoming.groundingChunks) {
    merged.groundingChunks = [
      ...(existing.groundingChunks ?? []),
      ...incoming.groundingChunks,
    ];
  }
  if (incoming.groundingSupports) {
    merged.groundingSupports = [
      ...(existing.groundingSupports ?? []),
      ...shiftGroundingSupports(incoming.groundingSupports, chunkOffset),
    ];
  }
  return merged;
}

/**
 * Converts live API usage metadata to `GenerateContentResponse` usage metadata.
 *
 * The live API names output tokens `responseTokenCount` /
 * `responseTokensDetails`, whereas `GenerateContentResponseUsageMetadata` names
 * them `candidatesTokenCount` / `candidatesTokensDetails`. Every field of both
 * types is optional, so forwarding the live shape unchanged compiles and leaves
 * `candidatesTokenCount` undefined for the caller.
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
  private readonly isGemini3xLiveModel: boolean;

  constructor(private readonly modelVersion?: string) {
    this.isGemini3xLiveModel = isGemini3xLive(modelVersion);
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
      yield* this.processServerContent(
        message.serverContent,
        !!message.toolCall,
      );
    }

    if (message.toolCall) {
      yield* this.processToolCall(message.toolCall);
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

  private *processServerContent(
    serverContent: LiveServerContent,
    hasToolCall: boolean,
  ): Generator<LlmResponse, void, void> {
    const content = serverContent.modelTurn;

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
        ...(serverContent.turnCompleteReason !== undefined
          ? {turnCompleteReason: serverContent.turnCompleteReason}
          : {}),
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
    }

    if (content && content.parts) {
      yield* this.processModelTurn(content, serverContent, hasToolCall);
    }

    yield* this.processTranscriptions(serverContent);

    if (serverContent.turnComplete) {
      yield* this.processTurnComplete(serverContent);
    }

    if (serverContent.interrupted) {
      yield* this.processInterrupted(serverContent);
    }
  }

  private *processModelTurn(
    content: Content,
    serverContent: LiveServerContent,
    hasToolCall: boolean,
  ): Generator<LlmResponse, void, void> {
    const parts = content.parts ?? [];
    const llmResponse: LlmResponse = {
      content,
      ...(serverContent.interrupted !== undefined
        ? {interrupted: serverContent.interrupted}
        : {}),
      ...(serverContent.turnCompleteReason !== undefined
        ? {turnCompleteReason: serverContent.turnCompleteReason}
        : {}),
      ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
    };

    if (!serverContent.turnComplete && serverContent.groundingMetadata) {
      llmResponse.groundingMetadata = serverContent.groundingMetadata;
    }

    // A part folded into a flushed full-text response must not appear again in
    // the partial response, so each flush records the parts it consumed.
    const endsTurn = !!(
      serverContent.turnComplete ||
      serverContent.interrupted ||
      hasToolCall
    );
    const flushedParts = new Set<Part>();
    let bufferedParts: Part[] = [];

    for (const part of parts) {
      if (part.text) {
        const currentIsThought = !!part.thought;
        if (this.text && currentIsThought !== this.isThought) {
          yield this.buildFullTextResponse(this.text, this.isThought);
          this.text = '';
          this.isThought = false;
          bufferedParts.forEach((buffered) => flushedParts.add(buffered));
          bufferedParts = [];
        }
        this.text += part.text;
        this.isThought = currentIsThought;
        llmResponse.partial = true;
        bufferedParts.push(part);
      } else if (this.text && !part.inlineData) {
        // don't yield the merged text event when receiving audio data
        yield this.buildFullTextResponse(
          this.text,
          this.isThought,
          this.pendingGroundingMetadata,
        );
        this.text = '';
        this.isThought = false;
        this.pendingGroundingMetadata = undefined;
        bufferedParts.forEach((buffered) => flushedParts.add(buffered));
        bufferedParts = [];
      }
    }

    if (endsTurn) {
      bufferedParts.forEach((buffered) => flushedParts.add(buffered));
    }
    if (flushedParts.size > 0) {
      llmResponse.content = {
        ...content,
        parts: parts.filter((part) => !flushedParts.has(part)),
      };
    }
    if (llmResponse.content?.parts?.length) {
      yield llmResponse;
    }
  }

  private *processTranscriptions(
    serverContent: LiveServerContent,
  ): Generator<LlmResponse, void, void> {
    if (serverContent.inputTranscription) {
      yield* this.processInputTranscription(serverContent.inputTranscription);
    }

    if (serverContent.outputTranscription) {
      if (serverContent.outputTranscription.text) {
        this.outputTranscriptionText += serverContent.outputTranscription.text;
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

    // The Gemini API or Vertex AI might not send a transcription finished
    // signal, so a completed or interrupted turn flushes what is pending.
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
  }

  private *processInputTranscription(
    inputTranscription: Transcription,
  ): Generator<LlmResponse, void, void> {
    // Gemini 3.x Live sends one final input transcription rather than a stream
    // of fragments, so there is nothing to accumulate.
    if (this.isGemini3xLiveModel) {
      if (inputTranscription.text) {
        yield {
          inputTranscription: {text: inputTranscription.text, finished: true},
          partial: false,
          ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
        };
      }
      return;
    }

    if (inputTranscription.text) {
      this.inputTranscriptionText += inputTranscription.text;
      yield {
        inputTranscription: {text: inputTranscription.text, finished: false},
        partial: true,
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
    }
    if (inputTranscription.finished) {
      yield {
        inputTranscription: {text: this.inputTranscriptionText, finished: true},
        partial: false,
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
      this.inputTranscriptionText = '';
    }
  }

  private *processTurnComplete(
    serverContent: LiveServerContent,
  ): Generator<LlmResponse, void, void> {
    warnOnIncompleteGrounding(this.finalGroundingMetadata(serverContent));

    if (this.text) {
      yield this.buildFullTextResponse(
        this.text,
        this.isThought,
        this.pendingGroundingMetadata,
        serverContent.interrupted,
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
      if (this.toolCallGroundingMetadata) {
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
    const groundingMetadata = this.finalGroundingMetadata(serverContent);
    if (groundingMetadata) {
      finalResponse.groundingMetadata = groundingMetadata;
    }
    if (serverContent.turnCompleteReason !== undefined) {
      finalResponse.turnCompleteReason = serverContent.turnCompleteReason;
    }
    const interactionStatus = readInteractionStatus(serverContent);
    if (interactionStatus !== undefined) {
      finalResponse.interactionStatus = interactionStatus;
    }
    yield finalResponse;

    this.pendingGroundingMetadata = undefined;
  }

  private *processInterrupted(
    serverContent: LiveServerContent,
  ): Generator<LlmResponse, void, void> {
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

  private *processToolCall(
    toolCall: LiveServerToolCall,
  ): Generator<LlmResponse, void, void> {
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

    if (toolCall.functionCalls) {
      this.toolCallParts.push(
        ...toolCall.functionCalls.map((functionCall) => ({functionCall})),
      );
    }

    if (!this.isGemini3xLiveModel) {
      // The buffered tool call keeps the grounding metadata that was current
      // when the model asked for it.
      this.toolCallGroundingMetadata ??= this.pendingGroundingMetadata;
      return;
    }

    // Gemini 3.x Live does not emit turnComplete until it receives the tool
    // response, so yield the tool call immediately to avoid deadlocking the
    // conversation.
    if (this.toolCallParts.length > 0) {
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

  /**
   * Returns the grounding metadata of a completed turn. Gemini 3.x Live reports
   * an empty object rather than no metadata at all.
   */
  private finalGroundingMetadata(
    serverContent: LiveServerContent,
  ): GroundingMetadata | undefined {
    return (
      serverContent.groundingMetadata ??
      this.pendingGroundingMetadata ??
      (this.isGemini3xLiveModel ? {} : undefined)
    );
  }

  private buildFullTextResponse(
    text: string,
    isThought: boolean,
    groundingMetadata?: GroundingMetadata,
    interrupted?: boolean,
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

/**
 * Warns when the backend reported retrieval queries but no chunks to cite.
 * Vertex AI Search does this on a transient failure.
 */
function warnOnIncompleteGrounding(
  groundingMetadata: GroundingMetadata | undefined,
): void {
  if (
    groundingMetadata?.retrievalQueries?.length &&
    !groundingMetadata.groundingChunks?.length
  ) {
    logger.warn(
      'Incomplete groundingMetadata received: retrievalQueries=' +
        `${JSON.stringify(groundingMetadata.retrievalQueries)} but ` +
        'groundingChunks is empty. This may indicate a transient issue with ' +
        'the Vertex AI Search backend.',
    );
  }
}
