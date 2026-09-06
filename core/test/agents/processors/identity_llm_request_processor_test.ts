/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  createSession,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/identity_llm_request_processor.js';

/** Forces `disallowTransferToParent` and `disallowTransferToPeers` to true. */
const OUTPUT_SCHEMA: Schema = {type: Type.OBJECT};

class RecordingLlm extends BaseLlm {
  lastRequest?: LlmRequest;

  constructor() {
    super({model: 'recording-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.lastRequest = request;
    yield {content: {parts: [{text: 'done'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

async function runAgentOnce(agent: LlmAgent): Promise<void> {
  const runner = new InMemoryRunner({agent});
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId: 'test_user',
  });
  for await (const _ of runner.runAsync({
    userId: 'test_user',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'Hi'}]},
  })) {
    // intentionally empty
  }
}

class MockRootAgent extends BaseAgent {
  constructor(name: string, subAgents: BaseAgent[] = []) {
    super({name, subAgents});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createMockInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function makeLlmRequest(): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

async function runProcessor(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest,
) {
  for await (const _ of IDENTITY_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // intentionally empty
  }
}

describe('IdentityLlmRequestProcessor', () => {
  it('should append agent name to system instruction', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "my_agent"',
    );
  });

  it('should append agent description when present', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      description: 'A helpful agent',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'The description about you is "A helpful agent"',
    );
  });

  it('should not append description when not provided', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).not.toContain(
      'The description about you is',
    );
  });

  it('should work for non-LlmAgent (BaseAgent subclass)', async () => {
    const agent = new MockRootAgent('base_agent');
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "base_agent"',
    );
  });

  it('should yield no events', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    const events = [];
    for await (const event of IDENTITY_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });

  it('should include both name and description in instruction', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      description: 'Processes data',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    const instruction = llmRequest.config?.systemInstruction as string;
    expect(instruction).toContain('my_agent');
    expect(instruction).toContain('Processes data');
  });

  it('names an agent whose outputSchema disables transfer', async () => {
    const agent = new LlmAgent({
      name: 'child_one',
      model: 'gemini-2.5-flash',
      outputSchema: OUTPUT_SCHEMA,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe(
      'You are an agent. Your internal name is "child_one".',
    );
  });

  it('keeps the preamble when only transfer to the parent is disabled', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: false,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "my_agent"',
    );
  });

  it('keeps the preamble when only transfer to peers is disabled', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: false,
      disallowTransferToPeers: true,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "my_agent"',
    );
  });

  it('keeps the preamble when transfer is disabled but the agent has sub-agents', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      subAgents: [new LlmAgent({name: 'leaf', model: 'gemini-2.5-flash'})],
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "my_agent"',
    );
  });

  it('matches the Python preamble for an agent with no description', async () => {
    const agent = new LlmAgent({name: 'agent', model: 'gemini-2.5-flash'});
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();
    llmRequest.config = {systemInstruction: ''};

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config.systemInstruction).toBe(
      'You are an agent. Your internal name is "agent".',
    );
  });

  it('joins the description into one instruction, with the trailing period', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: 'gemini-2.5-flash',
      description: 'test description',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();
    llmRequest.config = {systemInstruction: ''};

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config.systemInstruction).toBe(
      'You are an agent. Your internal name is "agent". ' +
        'The description about you is "test description".',
    );
  });

  it('skips the preamble for a single_turn agent', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: 'gemini-2.5-flash',
      mode: 'single_turn',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();
    llmRequest.config = {systemInstruction: ''};

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config.systemInstruction).toBe('');
  });

  it('creates no config for a single_turn agent that had none', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: 'gemini-2.5-flash',
      mode: 'single_turn',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config).toBeUndefined();
  });

  it('names an agent that cannot transfer anywhere', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe(
      'You are an agent. Your internal name is "agent".',
    );
  });
});

describe('identity instruction in the LlmAgent request chain', () => {
  it('puts the preamble ahead of the agent instruction', async () => {
    const model = new RecordingLlm();
    const agent = new LlmAgent({
      name: 'weather_agent',
      model,
      description: 'Answers questions about the weather.',
      instruction: 'Be concise.',
    });

    await runAgentOnce(agent);

    expect(model.lastRequest?.config?.systemInstruction).toBe(
      'You are an agent. Your internal name is "weather_agent". ' +
        'The description about you is "Answers questions about the weather.".' +
        '\n\nBe concise.',
    );
  });

  it('sends only the agent instruction for a single_turn agent', async () => {
    const model = new RecordingLlm();
    const agent = new LlmAgent({
      name: 'classifier',
      model,
      mode: 'single_turn',
      instruction: 'Reply with one of: bug, feature, question.',
    });

    await runAgentOnce(agent);

    expect(model.lastRequest?.config?.systemInstruction).toBe(
      'Reply with one of: bug, feature, question.',
    );
  });
});
