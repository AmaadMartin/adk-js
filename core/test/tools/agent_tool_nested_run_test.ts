/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `AgentTool` through a real `Runner`, with nothing mocked.
 *
 * The wrapped agent is a local class that records the run settings it was
 * given and answers without a model, so the whole path — nested run config,
 * argument serialization and toolset release — runs end to end offline.
 */

import {
  AgentTool,
  BaseAgent,
  BaseTool,
  BaseToolset,
  Context,
  createEvent,
  createSession,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunConfig,
  StreamingMode,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

class RecordingToolset extends BaseToolset {
  readonly closed = vi.fn();

  constructor() {
    super([]);
  }

  override async getTools(): Promise<BaseTool[]> {
    return [];
  }

  override async close(): Promise<void> {
    this.closed();
  }
}

/** An agent that answers without a model and records how it was run. */
class RecordingAgent extends LlmAgent {
  runConfig?: RunConfig;
  receivedText?: string;

  constructor(toolset: RecordingToolset) {
    super({
      name: 'sub_agent',
      model: 'gemini-2.5-flash',
      description: 'Answers with the text it was given.',
      tools: [toolset],
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.runConfig = context.runConfig;
    this.receivedText = context.userContent?.parts?.[0]?.text;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'sub-agent answer'}]},
    });
  }
}

function createToolContext(agent: BaseAgent, runConfig?: RunConfig): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'parent-invocation',
      agent,
      session: createSession({
        id: 'parent-session',
        appName: 'parent-app',
        userId: 'parent-user',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
      runConfig,
    }),
  });
}

describe('AgentTool driven by a real Runner', () => {
  it('runs the wrapped agent under the caller run config and releases its toolset', async () => {
    const toolset = new RecordingToolset();
    const agent = new RecordingAgent(toolset);
    const callerConfig: RunConfig = {
      maxLlmCalls: 7,
      supportCfc: true,
      streamingMode: StreamingMode.SSE,
    };

    const result = await new AgentTool({agent}).runAsync({
      args: {product: 'running shoes', brand: 'Nike'},
      toolContext: createToolContext(agent, callerConfig),
    });

    expect(result).toBe('sub-agent answer');
    expect(agent.receivedText).toBe(
      '{"brand":"Nike","product":"running shoes"}',
    );
    expect(agent.runConfig?.maxLlmCalls).toBe(7);
    expect(agent.runConfig?.supportCfc).toBe(false);
    expect(agent.runConfig?.streamingMode).toBe(StreamingMode.NONE);
    expect(callerConfig.supportCfc).toBe(true);
    expect(callerConfig.streamingMode).toBe(StreamingMode.SSE);
    // Once from the run's own cleanup, once from the tool's explicit release.
    expect(toolset.closed).toHaveBeenCalledTimes(2);
  });

  it('bounds the wrapped agent by the caller llm call ceiling', async () => {
    const toolset = new RecordingToolset();
    const agent = new RecordingAgent(toolset);
    const toolContext = createToolContext(agent, {maxLlmCalls: 3});

    await new AgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(agent.runConfig?.maxLlmCalls).toBe(3);
  });
});
