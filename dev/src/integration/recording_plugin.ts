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
import {Recording} from './test_types.js';

/**
 * Collects what `ReplayPlugin` later reads back.
 *
 * Entries are appended in call order and keyed by the same pair the replay
 * matches on, the index of the user message and the agent name. The recorder
 * sets {@link userMessageIndex} before it sends each message.
 *
 * For the session-state driven recorder that writes the fixture itself, see
 * `ConformanceRecordingPlugin`.
 */
export class RecordingPlugin extends BasePlugin {
  readonly recordings: Recording[] = [];
  userMessageIndex = 0;

  private readonly requestsInFlight = new Map<string, LlmRequest>();

  constructor() {
    super('recording-plugin');
  }

  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    this.requestsInFlight.set(callbackContext.agentName, llmRequest);
    return undefined;
  }

  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    const agentName = callbackContext.agentName;
    this.recordings.push({
      userMessageIndex: this.userMessageIndex,
      agentName,
      llmRecording: {
        llmRequest: this.requestsInFlight.get(agentName),
        llmResponses: [llmResponse],
      },
    });
    return undefined;
  }

  override async afterToolCallback({
    tool,
    toolArgs,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    this.recordings.push({
      userMessageIndex: this.userMessageIndex,
      agentName: toolContext.agentName,
      toolRecording: {
        toolCall: {name: tool.name, args: toolArgs},
        toolResponse: {name: tool.name, response: result},
      },
    });
    return undefined;
  }
}
