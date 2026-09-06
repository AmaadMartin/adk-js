/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Shared harness for the mock strategy tests. */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  RunAsyncToolRequest,
  StatefulParameter,
  ToolConnectionMap,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';
import {expect, vi} from 'vitest';

/** A model that replays canned responses and records the requests it got. */
export class RecordingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly turns: LlmResponse[][]) {
    super({model: 'recording-llm'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    const turn =
      this.turns[Math.min(this.requests.length - 1, this.turns.length - 1)];
    yield* turn ?? [];
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('A recording model does not support a live connection.');
  }
}

/** Wraps each chunk as a single-part model response. */
export function textResponses(chunks: string[]): LlmResponse[] {
  return chunks.map((text) => ({content: {role: 'model', parts: [{text}]}}));
}

/**
 * Points `LLMRegistry.newLlm` at a {@link RecordingLlm} replaying one array of
 * text chunks per call. The last turn repeats once every turn is used.
 *
 * The registry is stubbed rather than registered against, because
 * `LLMRegistry` caches its resolutions in a static cache shared by every test
 * file in the run.
 */
export function stubRegistryWithText(...turns: string[][]): RecordingLlm {
  const llm = new RecordingLlm(turns.map(textResponses));
  vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(llm);
  return llm;
}

/** The prompt text of the request `llm` received at `index`. */
export function promptOf(llm: RecordingLlm, index = 0): string {
  const request = llm.requests[index];
  if (!request) {
    expect.fail(`The model received no request at index ${index}.`);
  }
  return request.contents[0].parts?.[0].text ?? '';
}

/** A tool with a fixed declaration and no runtime behaviour. */
class StubTool extends BaseTool {
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

/** A tool that declares itself, so there is something to simulate against. */
export function declaredTool(name: string): BaseTool {
  return new StubTool(name, {name});
}

/** A tool with no declaration to simulate against. */
export function undeclaredTool(name: string): BaseTool {
  return new StubTool(name);
}

/** A connection map holding a single stateful parameter. */
export function connectionMap(parameter: StatefulParameter): ToolConnectionMap {
  return {statefulParameters: [parameter]};
}
