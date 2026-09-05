/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared fixtures for the environment simulation tests.
 *
 * adk-python's tests patch `LLMRegistry` per test. adk-js registers one fake
 * model class instead, so the analyzer and the strategy resolve it the way they
 * resolve a real one, and no test reaches the network. Vitest isolates modules
 * per test file, so the scripted text below belongs to one file at a time.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  Context,
  InvocationContext,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  LogLevel,
  Logger,
  PluginManager,
  RunAsyncToolRequest,
  createSession,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';

/** The model name the tests point `simulationModel` at. */
export const FAKE_SIMULATION_MODEL = 'env-sim-fake-model';

let scriptedChunks: string[] = [];

/** Every request the fake model has been sent since the last `scriptModel`. */
export const capturedRequests: LlmRequest[] = [];

/**
 * Scripts what the fake model streams back on its next calls, and forgets the
 * requests captured so far.
 *
 * @param chunks The text of each streamed response, in order.
 */
export function scriptModel(...chunks: string[]): void {
  scriptedChunks = chunks;
  capturedRequests.length = 0;
}

class FakeSimulationLlm extends BaseLlm {
  static override readonly supportedModels = [FAKE_SIMULATION_MODEL];

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    capturedRequests.push(llmRequest);
    for (const chunk of scriptedChunks) {
      yield {content: {role: 'model', parts: [{text: chunk}]}};
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('The fake simulation model has no live connection.');
  }
}

LLMRegistry.register(FakeSimulationLlm);

/** A tool that fails the test if the framework ever actually runs it. */
export class UncallableTool extends BaseTool {
  private readonly declaration?: FunctionDeclaration;

  constructor(name: string, declared = true) {
    super({name, description: `${name} description`});
    this.declaration = declared ? {name} : undefined;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    throw new Error(`Tool '${this.name}' was called for real.`);
  }
}

/** A logger that keeps what it was told, so a test can assert on a warning. */
export class RecordingLogger implements Logger {
  /** Every message passed to {@link warn}, joined the way the logger joins. */
  readonly warnings: string[] = [];

  setLogLevel(_level: LogLevel): void {}
  log(_level: LogLevel, ..._args: unknown[]): void {}
  debug(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {}
  error(..._args: unknown[]): void {}

  warn(...args: unknown[]): void {
    this.warnings.push(args.join(' '));
  }
}

/**
 * Builds a tool-call context.
 *
 * @param agent The agent driving the invocation, when the test needs one.
 * @returns A context whose `invocationContext` carries `agent`.
 */
export function createToolContext(agent?: InvocationContext['agent']): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
      agent,
    }),
  });
}
