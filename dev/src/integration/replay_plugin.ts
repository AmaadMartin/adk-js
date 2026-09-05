/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  Context,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {LlmRecording, Recording} from './recordings_schema.js';

function hasLlmResponse(recording: Recording): boolean {
  const llmRecording = recording.llmRecording;
  return Boolean(
    llmRecording?.llmResponse ?? llmRecording?.llmResponses?.length,
  );
}

/**
 * Returns the response a recording replays.
 *
 * adk-python's recorder writes `llmResponses`, the list of responses streamed
 * for one request. A beforeModelCallback answers one model call with one
 * response, so a recording holding several is a shape this replayer cannot
 * serve.
 */
function recordedLlmResponse(recording: LlmRecording): LlmResponse {
  if (recording.llmResponse) {
    return recording.llmResponse;
  }
  const responses = recording.llmResponses!;
  if (responses.length > 1) {
    throw new Error(
      `Cannot replay a recording holding ${responses.length} llmResponses: ` +
        'one model call is answered with one response.',
    );
  }
  return responses[0];
}

export class ReplayPlugin extends BasePlugin {
  constructor(
    private recordings: Recording[],
    private context: {userMessageIndex: number},
  ) {
    super('replay-plugin');
  }

  override async beforeModelCallback({
    callbackContext,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const agentName = callbackContext.agentName;
    const index = this.recordings.findIndex(
      (r) =>
        r.userMessageIndex === this.context.userMessageIndex &&
        r.agentName === agentName &&
        hasLlmResponse(r) &&
        // replay internal flag to mark event as consumed
        !(r as unknown as {_consumed: boolean})._consumed,
    );

    if (index === -1) {
      throw new Error(
        `No LLM recording found for agent ${agentName} at turn ${this.context.userMessageIndex}`,
      );
    }

    const rec = this.recordings[index];
    (rec as unknown as {_consumed: boolean})._consumed = true;

    return recordedLlmResponse(rec.llmRecording!);
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const agentName = params.toolContext.invocationContext.agent?.name ?? '';
    const toolName = params.tool.name;

    const index = this.recordings.findIndex(
      (r) =>
        r.userMessageIndex === this.context.userMessageIndex &&
        r.agentName === agentName &&
        r.toolRecording?.toolCall?.name === toolName &&
        !(r as unknown as {_consumed: boolean})._consumed,
    );

    if (index === -1) {
      throw new Error(
        `No tool recording found for agent ${agentName}, tool ${toolName} at turn ${this.context.userMessageIndex}`,
      );
    }

    const rec = this.recordings[index];
    (rec as unknown as {_consumed: boolean})._consumed = true;

    // Handle side effects for built-in tools that modify EventActions
    if (toolName === 'transfer_to_agent') {
      params.toolContext.actions.transferToAgent = params.toolArgs[
        'agentName'
      ] as string;
    }

    // The response from a tool call is a plain object.
    const response = rec.toolRecording!.toolResponse!.response;
    if (response instanceof Map) {
      return Object.fromEntries(response);
    }
    return response;
  }
}
