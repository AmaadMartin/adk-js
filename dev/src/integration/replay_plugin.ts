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
import {LlmRecording, Recording} from './test_types.js';

/**
 * Returns the response an LLM recording replays, or `undefined` when it holds
 * none.
 *
 * A recording written by adk-python carries `llm_responses`, which lists every
 * response of one model call. An SSE turn contributes several partial
 * responses followed by the complete one, and only the complete one is the
 * turn's answer. `llmResponse` is the older singular field, kept so goldens
 * written before the list landed keep replaying.
 */
export function recordedLlmResponse(
  llmRecording?: LlmRecording,
): LlmResponse | undefined {
  const responses = llmRecording?.llmResponses;
  if (responses?.length) {
    return responses.find((response) => !response.partial);
  }
  return llmRecording?.llmResponse;
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
        recordedLlmResponse(r.llmRecording) &&
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

    return recordedLlmResponse(rec.llmRecording)!;
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
