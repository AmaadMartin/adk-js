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
import {isDeepStrictEqual} from 'node:util';
import {Recording} from './test_types.js';

/** Raised when a replayed run diverges from what was recorded. */
export class ReplayVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayVerificationError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, ReplayVerificationError.prototype);
  }
}

export class ReplayPlugin extends BasePlugin {
  /** Tool recordings already replayed, tracked by identity. */
  private readonly consumedToolRecordings = new Set<Recording>();

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
        r.llmRecording?.llmResponse &&
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

    return rec.llmRecording!.llmResponse!;
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const agentName = params.toolContext.invocationContext.agent?.name ?? '';
    const toolName = params.tool.name;
    const userMessageIndex = this.context.userMessageIndex;

    const agentRecordings = this.recordings.filter(
      (r) =>
        r.userMessageIndex === userMessageIndex &&
        r.agentName === agentName &&
        r.toolRecording?.toolCall,
    );

    const index = agentRecordings.findIndex(
      (r) => !this.consumedToolRecordings.has(r),
    );
    if (index === -1) {
      throw new ReplayVerificationError(
        `Runtime sent more tool requests than expected for agent ` +
          `'${agentName}' at user_message_index ${userMessageIndex}: called ` +
          `'${toolName}', but only ${agentRecordings.length} tool ` +
          `recording(s) exist`,
      );
    }

    const rec = agentRecordings[index];
    this.consumedToolRecordings.add(rec);

    const recordedCall = rec.toolRecording!.toolCall!;
    if (recordedCall.name !== toolName) {
      throw new ReplayVerificationError(
        `Tool name mismatch for agent '${agentName}' at index ${index}:\n` +
          `recorded: '${recordedCall.name}'\ncurrent: '${toolName}'`,
      );
    }

    const recordedArgs = recordedCall.args ?? {};
    if (!isDeepStrictEqual(recordedArgs, params.toolArgs)) {
      throw new ReplayVerificationError(
        `Tool args mismatch for agent '${agentName}' at index ${index}:\n` +
          `recorded: ${JSON.stringify(recordedArgs)}\n` +
          `current: ${JSON.stringify(params.toolArgs)}`,
      );
    }

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
