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
  createSession,
  Event,
  InvocationContext,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  PluginManager,
  RunAsyncToolRequest,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';

/** The model name the tests point every simulation config at. */
export const SCRIPTED_MODEL = 'scripted-simulation-model';

/** One streamed chunk: its text, or `null` for a response carrying none. */
export type ReplyChunk = string | null;

const scriptedReplies: ReplyChunk[][] = [];

/** Every request {@link ScriptedLlm} has served, oldest first. */
export const capturedRequests: LlmRequest[] = [];

/**
 * Queues one reply for the next model call, split into streamed chunks.
 *
 * @param chunks The text chunks the model streams back.
 */
export function scriptReply(...chunks: ReplyChunk[]): void {
  scriptedReplies.push(chunks);
}

/** Drops every queued reply and every captured request. */
export function resetScriptedModel(): void {
  scriptedReplies.length = 0;
  capturedRequests.length = 0;
}

/** A model that replays the replies the test queued. */
class ScriptedLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    SCRIPTED_MODEL,
  ];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    capturedRequests.push(request);
    for (const chunk of scriptedReplies.shift() ?? []) {
      if (chunk === null) {
        yield {};
        continue;
      }
      yield {content: {role: 'model', parts: [{text: chunk}]}};
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections.');
  }
}

LLMRegistry.register(ScriptedLlm);

/** A tool that records whether it ran, and can withhold its declaration. */
export class FakeTool extends BaseTool {
  ranWith?: Record<string, unknown>;
  private readonly declaration?: FunctionDeclaration;

  constructor(name: string, options: {declared?: boolean} = {}) {
    super({name, description: `${name} description`});
    this.declaration =
      options.declared === false ? undefined : {name, description: name};
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    this.ranWith = request.args;
    return {ran: true};
  }
}

/** An agent that is not an `LlmAgent`, so it has no tools to analyze. */
export class NonLlmAgent extends BaseAgent {
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* [];
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* [];
  }
}

/**
 * Builds a tool context for a simulated call.
 *
 * @param agent The agent driving the invocation, when the test needs one.
 * @return The context to hand to the engine.
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
