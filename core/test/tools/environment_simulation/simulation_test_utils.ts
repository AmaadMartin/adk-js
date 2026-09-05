/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixtures shared by the environment simulation tests.
 *
 * adk-python patches `LLMRegistry` with `MagicMock`. adk-js installs a real
 * `BaseLlm` subclass instead, so the engine, the analyzer and the strategies
 * run their production code paths against it.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  BaseTool,
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  PluginManager,
  RunAsyncToolRequest,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';
import {vi} from 'vitest';

/** A model that replays a fixed list of responses and records its requests. */
export class FakeLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(
    model: string,
    private readonly responses: LlmResponse[],
  ) {
    super({model});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield* this.responses;
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('FakeLlm does not support a live connection.');
  }

  /** The prompt text of the most recent request. */
  get lastPrompt(): string {
    const request = this.requests.at(-1);
    return request?.contents.at(0)?.parts?.at(0)?.text ?? '';
  }
}

/**
 * Makes `LLMRegistry.newLlm` hand out a {@link FakeLlm} replaying `chunks`.
 *
 * Every caller in one test shares the instance, so a test can read the prompt
 * the analyzer or the strategy sent.
 */
export function installFakeLlm(...chunks: string[]): FakeLlm {
  return installFakeLlmResponses(
    ...chunks.map((text) => ({content: {role: 'model', parts: [{text}]}})),
  );
}

/** Makes `LLMRegistry.newLlm` hand out a model replaying `responses`. */
export function installFakeLlmResponses(...responses: LlmResponse[]): FakeLlm {
  const fakeLlm = new FakeLlm('fake-model', responses);
  vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(fakeLlm);
  return fakeLlm;
}

/** A tool that reports a declaration unless `declared` is false. */
export class FakeTool extends BaseTool {
  constructor(
    name: string,
    private readonly declared = true,
  ) {
    super({name, description: `${name} description`});
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declared ? {name: this.name} : undefined;
  }

  override async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    return {real: true};
  }
}

/**
 * Builds a tool context whose invocation runs `agent`.
 *
 * Omitting `agent` leaves the invocation without one, which is what the engine
 * sees when the caller is not an `LlmAgent`.
 */
export function makeToolContext(agent?: InvocationContext['agent']): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([] as BasePlugin[]),
      sessionService: new InMemorySessionService(),
    }),
  });
}
