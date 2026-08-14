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
import {Recording, ToolRecording} from './test_types.js';

/**
 * Returns whether a recording holds both halves of its pair.
 *
 * A model call the agent abandoned before the response arrived, and a tool
 * call that threw, leave a half-populated recording behind. Replay cannot use
 * one, so the recorder drops it.
 */
function isComplete(recording: Recording): boolean {
  if (recording.llmRecording) {
    return Boolean(recording.llmRecording.llmResponses?.length);
  }
  return recording.toolRecording?.toolResponse !== undefined;
}

/**
 * Collects the model and tool calls of a conformance run into recordings.
 *
 * The mirror of `ReplayPlugin`: attach it to a `Runner` driving the real
 * model, replay a test case's user messages, then serialize `recordings` into
 * the test case's `generated-recordings.yaml`.
 *
 * The plugin pairs `beforeModelCallback` with `afterModelCallback` by agent
 * name, and `beforeToolCallback` with `afterToolCallback` by function call id.
 * Recordings accumulate across the user messages of one test case, and their
 * order is the order the calls started, not the order they completed.
 */
export class RecordingPlugin extends BasePlugin {
  /** Every recording started so far, in the order the call started. */
  private readonly started: Recording[] = [];

  /** Response list of the model call in flight, keyed by agent name. */
  private readonly openLlmResponses = new Map<string, LlmResponse[]>();

  /** Tool recording in flight, keyed by function call id. */
  private readonly openToolRecordings = new Map<string, ToolRecording>();

  constructor(private context: {userMessageIndex: number}) {
    super('recording-plugin');
  }

  /** The complete recordings, in chronological order. */
  get recordings(): Recording[] {
    return this.started.filter(isComplete);
  }

  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<undefined> {
    const llmResponses: LlmResponse[] = [];
    this.started.push({
      userMessageIndex: this.context.userMessageIndex,
      agentName: callbackContext.agentName,
      llmRecording: {llmRequest, llmResponses},
    });
    this.openLlmResponses.set(callbackContext.agentName, llmResponses);
    return;
  }

  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<undefined> {
    const agentName = callbackContext.agentName;
    const llmResponses = this.openLlmResponses.get(agentName);
    if (!llmResponses) {
      return;
    }

    llmResponses.push(llmResponse);
    // An SSE turn streams partial responses before the complete one, so the
    // call stays open until a response arrives that is not partial.
    if (!llmResponse.partial) {
      this.openLlmResponses.delete(agentName);
    }
    return;
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<undefined> {
    const functionCallId = toolContext.functionCallId;
    if (!functionCallId) {
      return;
    }

    const toolRecording: ToolRecording = {
      toolCall: {id: functionCallId, name: tool.name, args: toolArgs},
    };
    this.started.push({
      userMessageIndex: this.context.userMessageIndex,
      agentName: toolContext.agentName,
      toolRecording,
    });
    this.openToolRecordings.set(functionCallId, toolRecording);
    return;
  }

  override async afterToolCallback({
    tool,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<undefined> {
    const functionCallId = toolContext.functionCallId;
    if (!functionCallId) {
      return;
    }

    const toolRecording = this.openToolRecordings.get(functionCallId);
    if (!toolRecording) {
      return;
    }

    this.openToolRecordings.delete(functionCallId);
    toolRecording.toolResponse = {
      id: functionCallId,
      name: tool.name,
      response: result,
    };
    return;
  }
}
