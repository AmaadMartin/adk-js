/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  Context,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
  SingleOnModelErrorCallback,
  SingleOnToolErrorCallback,
} from '@google/adk';
import {describe, expect, it, onTestFinished, vi} from 'vitest';
import {z} from 'zod/v3';
import {logger} from '../../src/utils/logger.js';

const MODEL_ERROR = new Error('model is unavailable');

/** A model that always fails, so the error path is the only path. */
class FailingLlm extends BaseLlm {
  constructor() {
    super({model: 'failing-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield* [];
    throw MODEL_ERROR;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('not used');
  }
}

/**
 * Calls `toolName` on the first turn, then answers with the text of the tool
 * result it was handed, so a test can read what answered the failed call.
 */
class ToolCallingLlm extends BaseLlm {
  constructor(private readonly toolName: string) {
    super({model: 'tool-calling-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const answers = (request.contents ?? []).flatMap((content) =>
      (content.parts ?? [])
        .map((part) => part.functionResponse?.response)
        .filter((response) => response !== undefined),
    );
    if (answers.length) {
      yield {
        content: {role: 'model', parts: [{text: JSON.stringify(answers[0])}]},
      };
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-1', name: this.toolName, args: {}}}],
      },
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('not used');
  }
}

class RecoveringPlugin extends BasePlugin {
  constructor(
    private readonly modelResponse?: LlmResponse,
    private readonly toolResponse?: Record<string, unknown>,
  ) {
    super('recovering_plugin');
  }

  override async onModelErrorCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    return this.modelResponse;
  }

  override async onToolErrorCallback(_params: {
    tool: {name: string};
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    return this.toolResponse;
  }
}

/** A tool that always throws, so the tool error path is the only path. */
function failingTool() {
  return new FunctionTool({
    name: 'failing_tool',
    description: 'always fails',
    parameters: z.object({}),
    execute: () => {
      throw new Error('tool exploded');
    },
  });
}

async function runTurn(agent: LlmAgent, plugins: BasePlugin[] = []) {
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    appName: 'test_app',
    agent,
    sessionService,
    plugins,
  });
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'test_user',
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'go'}]},
  })) {
    events.push(event);
  }
  return events;
}

function texts(events: Event[]): string[] {
  return events.flatMap((event) =>
    (event.content?.parts ?? [])
      .map((part) => part.text)
      .filter((text): text is string => !!text),
  );
}

describe('LlmAgent.canonicalOnModelErrorCallbacks', () => {
  it('is empty when no callback is set', () => {
    expect(new LlmAgent({name: 'a'}).canonicalOnModelErrorCallbacks).toEqual(
      [],
    );
  });

  it('wraps a single callback in an array', () => {
    const callback: SingleOnModelErrorCallback = () => undefined;

    expect(
      new LlmAgent({name: 'a', onModelErrorCallback: callback})
        .canonicalOnModelErrorCallbacks,
    ).toEqual([callback]);
  });

  it('returns the array it was given', () => {
    const callbacks: SingleOnModelErrorCallback[] = [() => undefined];

    expect(
      new LlmAgent({name: 'a', onModelErrorCallback: callbacks})
        .canonicalOnModelErrorCallbacks,
    ).toBe(callbacks);
  });
});

describe('LlmAgent.canonicalOnToolErrorCallbacks', () => {
  it('is empty when no callback is set', () => {
    expect(new LlmAgent({name: 'a'}).canonicalOnToolErrorCallbacks).toEqual([]);
  });

  it('wraps a single callback in an array', () => {
    const callback: SingleOnToolErrorCallback = () => undefined;

    expect(
      new LlmAgent({name: 'a', onToolErrorCallback: callback})
        .canonicalOnToolErrorCallbacks,
    ).toEqual([callback]);
  });

  it('returns the array it was given', () => {
    const callbacks: SingleOnToolErrorCallback[] = [() => undefined];

    expect(
      new LlmAgent({name: 'a', onToolErrorCallback: callbacks})
        .canonicalOnToolErrorCallbacks,
    ).toBe(callbacks);
  });
});

describe('onModelErrorCallback', () => {
  it('answers a failed model call from a synchronous callback', async () => {
    const agent = new LlmAgent({
      name: 'resilient',
      model: new FailingLlm(),
      onModelErrorCallback: ({error}) => ({
        content: {role: 'model', parts: [{text: `sorry: ${error.message}`}]},
      }),
    });

    const events = await runTurn(agent);

    expect(texts(events)).toContain('sorry: model is unavailable');
    expect(events.filter((event) => event.errorCode)).toHaveLength(0);
  });

  it('answers a failed model call from an async callback', async () => {
    const agent = new LlmAgent({
      name: 'resilient',
      model: new FailingLlm(),
      onModelErrorCallback: async () => ({
        content: {role: 'model', parts: [{text: 'async recovery'}]},
      }),
    });

    const events = await runTurn(agent);

    expect(texts(events)).toContain('async recovery');
  });

  it('receives the failed request and the error', async () => {
    const seen: Array<{model?: string; message: string}> = [];
    const agent = new LlmAgent({
      name: 'resilient',
      model: new FailingLlm(),
      onModelErrorCallback: ({request, error}) => {
        seen.push({model: request.model, message: error.message});
        return {content: {role: 'model', parts: [{text: 'handled'}]}};
      },
    });

    await runTurn(agent);

    expect(seen).toEqual([
      {model: 'failing-llm', message: 'model is unavailable'},
    ]);
  });

  it('runs the callbacks in order until one answers', async () => {
    const calls: string[] = [];
    const agent = new LlmAgent({
      name: 'resilient',
      model: new FailingLlm(),
      onModelErrorCallback: [
        () => {
          calls.push('first');
          return undefined;
        },
        () => {
          calls.push('second');
          return {content: {role: 'model', parts: [{text: 'second wins'}]}};
        },
        () => {
          calls.push('third');
          return {content: {role: 'model', parts: [{text: 'third'}]}};
        },
      ],
    });

    const events = await runTurn(agent);

    expect(calls).toEqual(['first', 'second']);
    expect(texts(events)).toContain('second wins');
  });

  it('reports the error when every callback declines it', async () => {
    const agent = new LlmAgent({
      name: 'resilient',
      model: new FailingLlm(),
      onModelErrorCallback: () => undefined,
    });

    const events = await runTurn(agent);

    const errors = events.filter((event) => event.errorCode);
    expect(errors).toHaveLength(1);
    expect(errors[0].errorMessage).toBe('model is unavailable');
  });

  it('lets a plugin answer before the agent callback runs', async () => {
    const agentCallback = vi.fn(() => undefined);
    const agent = new LlmAgent({
      name: 'resilient',
      model: new FailingLlm(),
      onModelErrorCallback: agentCallback,
    });

    const events = await runTurn(agent, [
      new RecoveringPlugin({
        content: {role: 'model', parts: [{text: 'plugin wins'}]},
      }),
    ]);

    expect(texts(events)).toContain('plugin wins');
    expect(agentCallback).not.toHaveBeenCalled();
  });
});

describe('onToolErrorCallback', () => {
  it('answers a failed tool call', async () => {
    const agent = new LlmAgent({
      name: 'resilient',
      model: new ToolCallingLlm('failing_tool'),
      tools: [failingTool()],
      onToolErrorCallback: ({tool, error}) => ({
        fallback: `${tool.name} failed: ${error.message}`,
      }),
    });

    const events = await runTurn(agent);

    // FunctionTool names the tool in the message it raises.
    expect(texts(events)).toContain(
      JSON.stringify({
        fallback:
          "failing_tool failed: Error in tool 'failing_tool': tool exploded",
      }),
    );
  });

  it('answers a call to a tool that does not exist', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    onTestFinished(() => warnSpy.mockRestore());
    const agent = new LlmAgent({
      name: 'resilient',
      model: new ToolCallingLlm('ghost_tool'),
      tools: [failingTool()],
      onToolErrorCallback: ({tool}) => ({
        fallback: `no such tool: ${tool.name}`,
      }),
    });

    const events = await runTurn(agent);

    expect(texts(events)).toContain(
      JSON.stringify({fallback: 'no such tool: ghost_tool'}),
    );
  });

  it('runs the callbacks in order until one answers', async () => {
    const calls: string[] = [];
    const agent = new LlmAgent({
      name: 'resilient',
      model: new ToolCallingLlm('failing_tool'),
      tools: [failingTool()],
      onToolErrorCallback: [
        () => {
          calls.push('first');
          return undefined;
        },
        () => {
          calls.push('second');
          return {fallback: 'second wins'};
        },
      ],
    });

    await runTurn(agent);

    expect(calls).toEqual(['first', 'second']);
  });

  it('hands the error to the model when every callback declines it', async () => {
    const agent = new LlmAgent({
      name: 'resilient',
      model: new ToolCallingLlm('failing_tool'),
      tools: [failingTool()],
      onToolErrorCallback: () => undefined,
    });

    const events = await runTurn(agent);

    expect(texts(events)).toContain(
      JSON.stringify({error: "Error in tool 'failing_tool': tool exploded"}),
    );
  });

  it('lets a plugin answer before the agent callback runs', async () => {
    const agentCallback = vi.fn(() => undefined);
    const agent = new LlmAgent({
      name: 'resilient',
      model: new ToolCallingLlm('failing_tool'),
      tools: [failingTool()],
      onToolErrorCallback: agentCallback,
    });

    const events = await runTurn(agent, [
      new RecoveringPlugin(undefined, {fallback: 'plugin wins'}),
    ]);

    expect(texts(events)).toContain(JSON.stringify({fallback: 'plugin wins'}));
    expect(agentCallback).not.toHaveBeenCalled();
  });
});
