/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FinishReason,
  GenerateContentConfig,
  GoogleGenAI,
  Part,
} from '@google/genai';

import {logger} from '../utils/logger.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * Extract the interaction ID from an Interactions SSE event.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractStreamInteractionId(event: any): string | undefined {
  if (event.interaction_id) return event.interaction_id;
  if (event.interactionId) return event.interactionId;
  if (event.interaction?.id) return event.interaction.id;
  if (
    (event.eventType === 'interaction' || event.event_type === 'interaction') &&
    event.id
  ) {
    return event.id;
  }
  return undefined;
}

/**
 * Convert a Part to an interaction content object.
 */
export function convertPartToInteractionContent(
  part: Part,
): Record<string, unknown> | null {
  if (part.text !== undefined && part.text !== null) {
    return {type: 'text', text: part.text};
  } else if (part.functionCall !== undefined) {
    const result: Record<string, unknown> = {
      type: 'function_call',
      id: part.functionCall.id ?? '',
      name: part.functionCall.name,
      arguments: part.functionCall.args ?? {},
    };
    if (part.thoughtSignature !== undefined) {
      let sig = part.thoughtSignature;
      if (typeof sig !== 'string') {
        sig = Buffer.from(sig).toString('base64');
      }
      result['thought_signature'] = sig;
    }
    return result;
  } else if (part.functionResponse !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any = part.functionResponse.response;
    if (
      typeof result !== 'object' &&
      typeof result !== 'string' &&
      !Array.isArray(result)
    ) {
      result = String(result);
    }
    logger.debug(
      `Converting function_response: name=${part.functionResponse.name}, call_id=${part.functionResponse.id}`,
    );
    return {
      type: 'function_result',
      name: part.functionResponse.name ?? '',
      call_id: part.functionResponse.id ?? '',
      result: result,
    };
  } else if (part.inlineData !== undefined) {
    const mimeType = part.inlineData.mimeType ?? '';
    if (mimeType.startsWith('image/')) {
      return {
        type: 'image',
        data: part.inlineData.data,
        mime_type: mimeType,
      };
    } else if (mimeType.startsWith('audio/')) {
      return {
        type: 'audio',
        data: part.inlineData.data,
        mime_type: mimeType,
      };
    } else if (mimeType.startsWith('video/')) {
      return {
        type: 'video',
        data: part.inlineData.data,
        mime_type: mimeType,
      };
    } else {
      return {
        type: 'document',
        data: part.inlineData.data,
        mime_type: mimeType,
      };
    }
  } else if (part.fileData !== undefined) {
    const mimeType = part.fileData.mimeType ?? '';
    if (mimeType.startsWith('image/')) {
      return {
        type: 'image',
        uri: part.fileData.fileUri,
        mime_type: mimeType,
      };
    } else if (mimeType.startsWith('audio/')) {
      return {
        type: 'audio',
        uri: part.fileData.fileUri,
        mime_type: mimeType,
      };
    } else if (mimeType.startsWith('video/')) {
      return {
        type: 'video',
        uri: part.fileData.fileUri,
        mime_type: mimeType,
      };
    } else {
      return {
        type: 'document',
        uri: part.fileData.fileUri,
        mime_type: mimeType,
      };
    }
  } else if (part.thought) {
    const result: Record<string, unknown> = {type: 'thought'};
    if (part.thoughtSignature !== undefined) {
      let sig = part.thoughtSignature;
      if (typeof sig !== 'string') {
        sig = Buffer.from(sig).toString('base64');
      }
      result['signature'] = sig;
    }
    return result;
  } else if (part.codeExecutionResult !== undefined) {
    const isError =
      part.codeExecutionResult.outcome === 'OUTCOME_FAILED' ||
      part.codeExecutionResult.outcome === 'OUTCOME_DEADLINE_EXCEEDED';
    return {
      type: 'code_execution_result',
      call_id: '',
      result: part.codeExecutionResult.output ?? '',
      is_error: isError,
    };
  } else if (part.executableCode !== undefined) {
    return {
      type: 'code_execution_call',
      id: '',
      arguments: {
        code: part.executableCode.code,
        language: part.executableCode.language,
      },
    };
  }
  return null;
}

/**
 * Convert a Content object to a TurnParam dict for interactions API.
 */
export function convertContentToTurn(
  content: Content,
): Record<string, unknown> {
  const contents: Record<string, unknown>[] = [];
  if (content.parts) {
    for (const part of content.parts) {
      const interactionContent = convertPartToInteractionContent(part);
      if (interactionContent) {
        contents.push(interactionContent);
      }
    }
  }

  return {
    role: content.role ?? 'user',
    content: contents,
  };
}

/**
 * Convert a list of Content objects to interactions API input format.
 */
export function convertContentsToTurns(
  contents: Content[],
): Record<string, unknown>[] {
  const turns: Record<string, unknown>[] = [];
  for (const content of contents) {
    const turn = convertContentToTurn(content);
    if (Array.isArray(turn.content) && turn.content.length > 0) {
      turns.push(turn);
    }
  }
  return turns;
}

/**
 * Convert tools from GenerateContentConfig to interactions API format.
 */
export function convertToolsConfigToInteractionsFormat(
  config?: GenerateContentConfig,
): Record<string, unknown>[] {
  if (!config?.tools?.length) {
    return [];
  }

  const interactionTools: Record<string, unknown>[] = [];
  for (const rawTool of config.tools) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool: any = rawTool;
    if (tool.functionDeclarations) {
      for (const funcDecl of tool.functionDeclarations) {
        const funcTool: Record<string, unknown> = {
          type: 'function',
          name: funcDecl.name,
        };
        if (funcDecl.description) {
          funcTool['description'] = funcDecl.description;
        }
        if (funcDecl.parameters) {
          funcTool['parameters'] = funcDecl.parameters;
        }
        interactionTools.push(funcTool);
      }
    }
    if (tool.googleSearch) {
      interactionTools.push({type: 'google_search'});
    }
    if (tool.codeExecution) {
      interactionTools.push({type: 'code_execution'});
    }
    if (tool.urlContext) {
      interactionTools.push({type: 'url_context'});
    }
    if (tool.computerUse) {
      interactionTools.push({type: 'computer_use'});
    }
  }
  return interactionTools;
}

/**
 * Convert an interaction output content to a Part.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertInteractionOutputToPart(output: any): Part | null {
  if (!output || !output.type) {
    return null;
  }

  const outputType = output.type;

  if (outputType === 'text') {
    return {text: output.text ?? ''};
  } else if (outputType === 'function_call') {
    logger.debug(
      `Converting function_call output: name=${output.name}, id=${output.id}`,
    );
    let thoughtSignature: unknown = undefined;
    if (output.thought_signature) {
      if (typeof output.thought_signature === 'string') {
        thoughtSignature = Buffer.from(output.thought_signature, 'base64');
      } else {
        thoughtSignature = output.thought_signature;
      }
    }
    const part: Part = {
      functionCall: {
        id: output.id ?? '',
        name: output.name,
        args: output.arguments ?? {},
      },
    };
    if (thoughtSignature) {
      // @ts-expect-error thoughtSignature type casting
      part.thoughtSignature = thoughtSignature;
    }
    return part;
  } else if (outputType === 'function_result') {
    const result = output.result;
    let resultValue = result;
    if (result && typeof result === 'object' && 'items' in result) {
      resultValue = result.items;
    }
    return {
      functionResponse: {
        id: output.call_id ?? '',
        name: output.name ?? '',
        response: resultValue,
      },
    };
  } else if (outputType === 'image') {
    if (output.data) {
      return {
        inlineData: {
          data: output.data,
          mimeType: output.mime_type,
        },
      };
    } else if (output.uri) {
      return {
        fileData: {
          fileUri: output.uri,
          mimeType: output.mime_type,
        },
      };
    }
  } else if (outputType === 'audio') {
    if (output.data) {
      return {
        inlineData: {
          data: output.data,
          mimeType: output.mime_type,
        },
      };
    } else if (output.uri) {
      return {
        fileData: {
          fileUri: output.uri,
          mimeType: output.mime_type,
        },
      };
    }
  } else if (outputType === 'thought') {
    return null;
  } else if (outputType === 'code_execution_result') {
    return {
      codeExecutionResult: {
        output: output.result ?? '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outcome: (output.is_error ? 'outcomeFailed' : 'outcomeOk') as any,
      },
    };
  } else if (outputType === 'code_execution_call') {
    const args = output.arguments ?? {};
    return {
      executableCode: {
        code: args.code ?? '',
        language: args.language ?? 'PYTHON',
      },
    };
  } else if (outputType === 'google_search_result') {
    if (output.result && Array.isArray(output.result)) {
      const resultsText = output.result.map(String).join('\n');
      return {text: resultsText};
    }
  }

  return null;
}

/**
 * Convert an Interaction response to an LlmResponse.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertInteractionToLlmResponse(interaction: any): LlmResponse {
  if (interaction.status === 'failed') {
    let errorMsg = 'Unknown error';
    let errorCode = 'UNKNOWN_ERROR';
    if (interaction.error) {
      errorMsg = interaction.error.message ?? errorMsg;
      errorCode = interaction.error.code ?? errorCode;
    }
    return {
      errorCode,
      errorMessage: errorMsg,
      interactionId: interaction.id,
    };
  }

  const parts: Part[] = [];
  if (interaction.outputs && Array.isArray(interaction.outputs)) {
    for (const output of interaction.outputs) {
      const part = convertInteractionOutputToPart(output);
      if (part) {
        parts.push(part);
      }
    }
  }

  let content: Content | undefined = undefined;
  if (parts.length > 0) {
    content = {role: 'model', parts};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let usageMetadata: any = undefined;
  if (interaction.usage) {
    const promptTokenCount =
      interaction.usage.total_input_tokens ??
      interaction.usage.totalInputTokens ??
      0;
    const candidatesTokenCount =
      interaction.usage.total_output_tokens ??
      interaction.usage.totalOutputTokens ??
      0;
    usageMetadata = {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
    };
  }

  let finishReason: FinishReason | undefined = undefined;
  if (
    interaction.status === 'completed' ||
    interaction.status === 'requires_action'
  ) {
    // @ts-expect-error casting string to FinishReason
    finishReason = 'STOP';
  }

  return {
    content,
    usageMetadata,
    finishReason,
    turnComplete:
      interaction.status === 'completed' ||
      interaction.status === 'requires_action',
    interactionId: interaction.id,
  };
}

/**
 * Convert an InteractionSSEEvent to an LlmResponse for streaming.
 */
export function convertInteractionEventToLlmResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
  aggregatedParts: Part[],
  interactionId?: string,
): LlmResponse | null {
  const eventType = event.eventType ?? event.event_type;

  if (eventType === 'content.delta') {
    const delta = event.delta;
    if (!delta) return null;

    const deltaType = delta.type;

    if (deltaType === 'text') {
      const text = delta.text ?? '';
      if (text) {
        const part: Part = {text};
        aggregatedParts.push(part);
        return {
          content: {role: 'model', parts: [part]},
          partial: true,
          turnComplete: false,
          interactionId,
        };
      }
    } else if (deltaType === 'function_call') {
      if (delta.name) {
        let thoughtSignature: unknown = undefined;
        if (delta.thought_signature) {
          if (typeof delta.thought_signature === 'string') {
            thoughtSignature = Buffer.from(delta.thought_signature, 'base64');
          } else {
            thoughtSignature = delta.thought_signature;
          }
        }
        const part: Part = {
          functionCall: {
            id: delta.id ?? '',
            name: delta.name,
            args: delta.arguments ?? {},
          },
        };
        if (thoughtSignature) {
          // @ts-expect-error thoughtSignature type casting
          part.thoughtSignature = thoughtSignature;
        }
        aggregatedParts.push(part);
        return null;
      }
    } else if (deltaType === 'image') {
      if (delta.data || delta.uri) {
        const part: Part = delta.data
          ? {inlineData: {data: delta.data, mimeType: delta.mime_type}}
          : {fileData: {fileUri: delta.uri, mimeType: delta.mime_type}};
        aggregatedParts.push(part);
        return {
          content: {role: 'model', parts: [part]},
          partial: false,
          turnComplete: false,
          interactionId,
        };
      }
    }
  } else if (eventType === 'content.stop') {
    if (aggregatedParts.length > 0) {
      return {
        content: {role: 'model', parts: [...aggregatedParts]},
        partial: false,
        turnComplete: false,
        interactionId,
      };
    }
  } else if (eventType === 'interaction') {
    return convertInteractionToLlmResponse(event);
  } else if (eventType === 'interaction.status_update') {
    const status = event.status;
    if (status === 'completed' || status === 'requires_action') {
      return {
        content:
          aggregatedParts.length > 0
            ? {role: 'model', parts: [...aggregatedParts]}
            : undefined,
        partial: false,
        turnComplete: true,
        // @ts-expect-error casting string to FinishReason
        finishReason: 'STOP',
        interactionId,
      };
    } else if (status === 'failed') {
      const error = event.error;
      return {
        errorCode: error?.code ?? 'UNKNOWN_ERROR',
        errorMessage: error?.message ?? 'Unknown error',
        turnComplete: true,
        interactionId,
      };
    }
  } else if (eventType === 'error') {
    return {
      errorCode: event.code ?? 'UNKNOWN_ERROR',
      errorMessage: event.message ?? 'Unknown error',
      turnComplete: true,
      interactionId,
    };
  }

  return null;
}

/**
 * Extract the latest turn contents for interactions API.
 */
export function getLatestUserContents(contents: Content[]): Content[] {
  if (!contents?.length) {
    return [];
  }

  const latestUserContents: Content[] = [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.role === 'user') {
      latestUserContents.unshift(content);
    } else {
      break;
    }
  }

  let hasFunctionResult = false;
  for (const content of latestUserContents) {
    if (content.parts) {
      for (const part of content.parts) {
        if (part.functionResponse !== undefined) {
          hasFunctionResult = true;
          break;
        }
      }
    }
    if (hasFunctionResult) {
      break;
    }
  }

  if (hasFunctionResult && contents.length > latestUserContents.length) {
    const userStartIdx = contents.length - latestUserContents.length;
    if (userStartIdx > 0) {
      const precedingContent = contents[userStartIdx - 1];
      if (precedingContent.role === 'model' && precedingContent.parts) {
        for (const part of precedingContent.parts) {
          if (part.functionCall !== undefined) {
            return [precedingContent, ...latestUserContents];
          }
        }
      }
    }
  }

  return latestUserContents;
}

export function extractSystemInstruction(
  config?: GenerateContentConfig,
): string | undefined {
  if (!config?.systemInstruction) {
    return undefined;
  }

  if (typeof config.systemInstruction === 'string') {
    return config.systemInstruction;
  }
  if (typeof config.systemInstruction === 'object') {
    // @ts-expect-error systemInstruction as Content
    const parts = config.systemInstruction.parts;
    if (Array.isArray(parts)) {
      return parts.map((p: Part) => p.text ?? '').join('\n');
    }
  }
  return undefined;
}

export function buildGenerationConfig(
  config?: GenerateContentConfig,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {};
  if (!config) return generationConfig;

  if (config.temperature !== undefined)
    generationConfig['temperature'] = config.temperature;
  if (config.topP !== undefined) generationConfig['topP'] = config.topP;
  if (config.topK !== undefined) generationConfig['topK'] = config.topK;
  if (config.maxOutputTokens !== undefined)
    generationConfig['maxOutputTokens'] = config.maxOutputTokens;
  if (config.stopSequences?.length)
    generationConfig['stopSequences'] = config.stopSequences;
  if (config.presencePenalty !== undefined)
    generationConfig['presencePenalty'] = config.presencePenalty;
  if (config.frequencyPenalty !== undefined)
    generationConfig['frequencyPenalty'] = config.frequencyPenalty;

  return generationConfig;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildInteractionsRequestLog(params: any): string {
  return `Interactions API Request:\nModel: ${params.model}\nStream: ${params.stream}\nPrevious Interaction ID: ${params.previousInteractionId}\n`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildInteractionsResponseLog(interaction: any): string {
  return `Interactions API Response:\nInteraction ID: ${interaction.id}\nStatus: ${interaction.status}\n`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildInteractionsEventLog(event: any): string {
  return `Interactions SSE Event: ${event.eventType ?? event.event_type}\n`;
}

/**
 * Generate content using the interactions API.
 */
export async function* generateContentViaInteractions(
  apiClient: GoogleGenAI,
  llmRequest: LlmRequest,
  stream: boolean,
): AsyncGenerator<LlmResponse, void> {
  let contents = llmRequest.contents;
  if (llmRequest.previousInteractionId && contents?.length) {
    contents = getLatestUserContents(contents);
  }

  const inputTurns = convertContentsToTurns(contents);
  const interactionTools = convertToolsConfigToInteractionsFormat(
    llmRequest.config,
  );
  const systemInstruction = extractSystemInstruction(llmRequest.config);
  const generationConfig = buildGenerationConfig(llmRequest.config);

  const previousInteractionId = llmRequest.previousInteractionId;

  logger.info(
    `Sending request via interactions API, model: ${llmRequest.model}, stream: ${stream}, previousInteractionId: ${previousInteractionId}`,
  );

  logger.debug(
    buildInteractionsRequestLog({
      model: llmRequest.model ?? '',
      inputTurns,
      systemInstruction,
      tools: interactionTools.length ? interactionTools : undefined,
      generationConfig: Object.keys(generationConfig).length
        ? generationConfig
        : undefined,
      previousInteractionId,
      stream,
    }),
  );

  let currentInteractionId: string | undefined = undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interactionsApi: any = (apiClient as any).interactions;
  if (!interactionsApi) {
    throw new Error(
      'Interactions API is not available on the GoogleGenAI client.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finalTools: any =
    interactionTools.length > 0 ? interactionTools : undefined;
  const finalGenerationConfig =
    Object.keys(generationConfig).length > 0 ? generationConfig : undefined;

  if (stream) {
    const responseStream = await interactionsApi.create({
      model: llmRequest.model ?? '',
      input: inputTurns,
      stream: true,
      systemInstruction,
      tools: finalTools,
      generationConfig: finalGenerationConfig,
      previousInteractionId,
    });

    const aggregatedParts: Part[] = [];
    for await (const event of responseStream) {
      logger.debug(buildInteractionsEventLog(event));

      const interactionId = extractStreamInteractionId(event);
      if (interactionId) {
        currentInteractionId = interactionId;
      }

      const llmResponse = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        currentInteractionId,
      );
      if (llmResponse) {
        yield llmResponse;
      }
    }

    if (aggregatedParts.length > 0) {
      yield {
        content: {role: 'model', parts: aggregatedParts},
        partial: false,
        turnComplete: true,
        // @ts-expect-error casting string to FinishReason
        finishReason: 'STOP',
        interactionId: currentInteractionId,
      };
    }
  } else {
    const interaction = await interactionsApi.create({
      model: llmRequest.model ?? '',
      input: inputTurns,
      stream: false,
      systemInstruction,
      tools: finalTools,
      generationConfig: finalGenerationConfig,
      previousInteractionId,
    });

    logger.info('Interaction response received from the model.');
    logger.debug(buildInteractionsResponseLog(interaction));

    yield convertInteractionToLlmResponse(interaction);
  }
}
