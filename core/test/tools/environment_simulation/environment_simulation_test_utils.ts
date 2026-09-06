/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  Context,
  InvocationContext,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  PluginManager,
  RunAsyncToolRequest,
  Session,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';
import {expect, vi} from 'vitest';

/** A model that replays canned responses and records the requests it got. */
export class RecordingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'test-model'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield* this.responses;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not supported by RecordingLlm.');
  }
}

/** Wraps each chunk as a single-part model response. */
export function textResponses(chunks: string[]): LlmResponse[] {
  return chunks.map((text) => ({content: {role: 'model', parts: [{text}]}}));
}

/** Points `LLMRegistry.newLlm` at a {@link RecordingLlm} replaying responses. */
export function stubRegistry(responses: LlmResponse[]): RecordingLlm {
  const llm = new RecordingLlm(responses);
  vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(llm);
  return llm;
}

/** {@link stubRegistry} for a model replaying plain text chunks. */
export function stubRegistryWithText(chunks: string[]): RecordingLlm {
  return stubRegistry(textResponses(chunks));
}

/** The prompt text of the request `llm` received at `index`. */
export function promptOf(llm: RecordingLlm, index = 0): string {
  const request = llm.requests[index];
  expect(request).toBeDefined();
  return request.contents[0].parts?.[0].text ?? '';
}

/** A tool with a fixed declaration and no runtime behaviour. */
export class StubTool extends BaseTool {
  constructor(
    name: string,
    private readonly declaration?: FunctionDeclaration,
  ) {
    super({name, description: `${name} description`});
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    throw new Error('A simulated tool must never actually run.');
  }
}

function createSession(): Session {
  return {
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    state: {},
    events: [],
    lastUpdateTime: 0,
  };
}

/** Builds the tool-call context of an invocation running `agent`. */
export function createToolContext(agent: BaseAgent): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession(),
      pluginManager: new PluginManager(),
    }),
  });
}
