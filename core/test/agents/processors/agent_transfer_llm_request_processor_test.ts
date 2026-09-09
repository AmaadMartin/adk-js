/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTransferLlmRequestProcessor,
  BaseAgent,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const AGENT_TRANSFER_LLM_REQUEST_PROCESSOR =
  new AgentTransferLlmRequestProcessor();

class MockRootAgent extends BaseAgent {
  constructor(
    name: string,
    description: string = '',
    subAgents: BaseAgent[] = [],
  ) {
    super({name, description, subAgents});
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

describe('AgentTransferLlmRequestProcessor', () => {
  it('should do nothing if agent is not an LlmAgent', async () => {
    const agent = new MockRootAgent('test_agent');
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.contents).toHaveLength(0);
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeUndefined();
  });

  it('should do nothing if LlmAgent has no transfer targets', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.contents).toHaveLength(0);
  });

  it('should append instructions and register tool when sub-agents exist', async () => {
    const subAgent = new LlmAgent({
      name: 'sub_agent',
      model: 'gemini-2.5-flash',
      description: 'Answers sub questions',
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [subAgent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    // Verify instructions appended
    expect(llmRequest.config?.systemInstruction).toContain(
      'You have a list of other agents to transfer to',
    );
    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: sub_agent',
    );

    // Verify tool registered
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });

  it('should respect disallowTransferToParent', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
    });
    new LlmAgent({
      name: 'parent_agent',
      model: 'gemini-2.5-flash',
      subAgents: [agent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    // Should not include parent agent if disallowTransferToParent is true and no other targets
    expect(llmRequest.contents).toHaveLength(0);
  });

  it('should include parent agent if allowed', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: false,
    });
    new LlmAgent({
      name: 'parent_agent',
      model: 'gemini-2.5-flash',
      description: 'Parent agent',
      subAgents: [agent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: parent_agent',
    );
  });

  it('should include peer agents if allowed', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToPeers: false,
    });
    const peerAgent = new LlmAgent({
      name: 'peer_agent',
      model: 'gemini-2.5-flash',
      description: 'Peer agent',
    });
    new LlmAgent({
      name: 'parent_agent',
      model: 'gemini-2.5-flash',
      subAgents: [agent, peerAgent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: peer_agent',
    );
  });

  it('should execute transfer_to_agent tool successfully', async () => {
    const subAgent = new LlmAgent({
      name: 'sub_agent',
      model: 'gemini-2.5-flash',
      description: 'Answers sub questions',
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [subAgent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    const tool = llmRequest.toolsDict['transfer_to_agent'];
    expect(tool).toBeDefined();

    const toolContext = new Context({invocationContext});
    const result = await tool.runAsync({
      args: {agentName: 'sub_agent'},
      toolContext,
    });

    expect(result).toEqual('Transfer queued');
    expect(toolContext.actions.transferToAgent).toEqual('sub_agent');
  });

  it('should exclude a task-mode sub-agent from the transfer targets', async () => {
    const taskSub = new LlmAgent({
      name: 'task_sub',
      model: 'gemini-2.5-flash',
      description: 'A workflow node agent',
      mode: 'task',
    });
    const chatSub = new LlmAgent({
      name: 'chat_sub',
      model: 'gemini-2.5-flash',
      description: 'A conversational agent',
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [taskSub, chatSub],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: chat_sub',
    );
    expect(llmRequest.config?.systemInstruction).not.toContain(
      'Agent name: task_sub',
    );
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });

  it('should exclude a single_turn sub-agent from the transfer targets', async () => {
    const singleTurnSub = new LlmAgent({
      name: 'single_turn_sub',
      model: 'gemini-2.5-flash',
      description: 'A workflow node agent',
      mode: 'single_turn',
    });
    const chatSub = new LlmAgent({
      name: 'chat_sub',
      model: 'gemini-2.5-flash',
      description: 'A conversational agent',
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [singleTurnSub, chatSub],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: chat_sub',
    );
    expect(llmRequest.config?.systemInstruction).not.toContain(
      'Agent name: single_turn_sub',
    );
  });

  it('should register nothing when the only sub-agent is a workflow node agent', async () => {
    const taskSub = new LlmAgent({
      name: 'task_sub',
      model: 'gemini-2.5-flash',
      description: 'A workflow node agent',
      mode: 'task',
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [taskSub],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeUndefined();
  });

  it('should exclude a task-mode peer agent', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToPeers: false,
    });
    const taskPeer = new LlmAgent({
      name: 'task_peer',
      model: 'gemini-2.5-flash',
      description: 'A workflow node peer',
      mode: 'task',
    });
    const chatPeer = new LlmAgent({
      name: 'chat_peer',
      model: 'gemini-2.5-flash',
      description: 'A conversational peer',
    });
    new LlmAgent({
      name: 'parent_agent',
      model: 'gemini-2.5-flash',
      description: 'Parent agent',
      subAgents: [agent, taskPeer, chatPeer],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: chat_peer',
    );
    expect(llmRequest.config?.systemInstruction).not.toContain(
      'Agent name: task_peer',
    );
  });

  it('should keep a sub-agent that has no mode', async () => {
    const noModeSub = new MockRootAgent('no_mode_sub', 'A non-LlmAgent');
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [noModeSub],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: no_mode_sub',
    );
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });

  it('should give a task-mode agent no transfer instructions', async () => {
    const subAgent = new LlmAgent({
      name: 'sub_agent',
      model: 'gemini-2.5-flash',
      description: 'Answers sub questions',
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      mode: 'task',
      subAgents: [subAgent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    const systemInstruction = llmRequest.config?.systemInstruction ?? '';
    expect(systemInstruction).not.toContain(
      'You have a list of other agents to transfer to',
    );
    expect(systemInstruction).not.toContain('Agent name: sub_agent');
    // adk-python registers the tool for a node agent too; only the
    // instructions are suppressed.
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });

  it('should give a single_turn agent no transfer instructions', async () => {
    const subAgent = new LlmAgent({
      name: 'sub_agent',
      model: 'gemini-2.5-flash',
      description: 'Answers sub questions',
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      mode: 'single_turn',
      subAgents: [subAgent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    const systemInstruction = llmRequest.config?.systemInstruction ?? '';
    expect(systemInstruction).not.toContain(
      'You have a list of other agents to transfer to',
    );
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });
});
