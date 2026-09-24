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
  createSession,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';

/** The model name the tests configure the simulator with. */
export const FAKE_SIMULATION_MODEL = 'fake-simulation-model';

/** The answers the fake model returns, one entry per call. */
const scriptedAnswers: string[][] = [];

/** Every request the fake model received, in order. */
export const recordedRequests: LlmRequest[] = [];

/**
 * A model that answers with whatever {@link scriptModelAnswer} queued.
 *
 * Registering it means the code under test resolves a model through the real
 * registry, so the model name on the config is exercised rather than stubbed.
 */
class FakeSimulationLlm extends BaseLlm {
  static override readonly supportedModels = [FAKE_SIMULATION_MODEL];

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    recordedRequests.push(llmRequest);
    for (const chunk of scriptedAnswers.shift() ?? []) {
      yield {content: {role: 'model', parts: [{text: chunk}]}};
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('The fake simulation model has no live connection.');
  }
}

LLMRegistry.register(FakeSimulationLlm);

/** The model name whose answer arrives with parts that carry no text. */
export const PARTLESS_SIMULATION_MODEL = 'partless-simulation-model';

/** A model whose stream carries responses with nothing to read. */
class PartlessSimulationLlm extends BaseLlm {
  static override readonly supportedModels = [PARTLESS_SIMULATION_MODEL];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {};
    yield {content: {role: 'model'}};
    yield {content: {role: 'model', parts: [{}]}};
    yield {content: {role: 'model', parts: [{text: '{"ok": true}'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('The partless simulation model has no live connection.');
  }
}

LLMRegistry.register(PartlessSimulationLlm);

/**
 * Queues one answer for the next call to the fake model.
 *
 * @param chunks The text parts the model streams back, in order.
 */
export function scriptModelAnswer(...chunks: string[]): void {
  scriptedAnswers.push(chunks);
}

/** Forgets every queued answer and every recorded request. */
export function resetFakeModel(): void {
  scriptedAnswers.length = 0;
  recordedRequests.length = 0;
}

/** A tool that reports the declaration it was built with. */
export class FakeTool extends BaseTool {
  private readonly declaration?: FunctionDeclaration;

  constructor(params: {name: string; declared?: boolean}) {
    super({name: params.name, description: `${params.name} description`});
    this.declaration =
      params.declared === false ? undefined : {name: params.name};
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  async runAsync(): Promise<unknown> {
    return {called: this.name};
  }
}

/**
 * Builds a tool context, optionally carrying the agent that is running.
 *
 * @param agent The agent on the invocation, if the test needs one.
 * @returns A context the engine can read the agent off.
 */
export function createToolContext(agent?: BaseAgent): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    }),
  });
}
