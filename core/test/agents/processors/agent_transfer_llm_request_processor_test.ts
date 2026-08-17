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

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

async function runProcessor(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest,
): Promise<void> {
  for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // The processor only mutates the request; it yields no events.
  }
}

function transferDeclarationEnum(llmRequest: LlmRequest): string[] | undefined {
  const tool = llmRequest.config?.tools?.[0];
  if (!tool || !('functionDeclarations' in tool)) {
    return expect.fail('the request declares no function tool');
  }
  const declaration = tool.functionDeclarations?.[0];
  return declaration?.parameters?.properties?.['agentName'].enum;
}

/**
 * Builds an agent whose targets are a sub-agent, its parent and a peer, named
 * so that their natural order differs from their alphabetical order.
 */
function createAgentWithThreeTargets(): LlmAgent {
  const agent = new LlmAgent({
    name: 'test_agent',
    model: 'gemini-2.5-flash',
    subAgents: [new LlmAgent({name: 'zeta_agent', model: 'gemini-2.5-flash'})],
  });
  new LlmAgent({
    name: 'mid_agent',
    model: 'gemini-2.5-flash',
    subAgents: [
      agent,
      new LlmAgent({name: 'alpha_agent', model: 'gemini-2.5-flash'}),
    ],
  });
  return agent;
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

  it('constrains the declared agentName to the transfer targets', async () => {
    const invocationContext = createMockInvocationContext(
      createAgentWithThreeTargets(),
    );
    const llmRequest = createLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(transferDeclarationEnum(llmRequest)).toEqual([
      'zeta_agent',
      'mid_agent',
      'alpha_agent',
    ]);
  });

  it('registers the tool that declares those transfer targets', async () => {
    const invocationContext = createMockInvocationContext(
      createAgentWithThreeTargets(),
    );
    const llmRequest = createLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    const tool = llmRequest.toolsDict['transfer_to_agent'];
    expect(
      tool._getDeclaration()?.parameters?.properties?.['agentName'].enum,
    ).toEqual(['zeta_agent', 'mid_agent', 'alpha_agent']);
  });

  it('declares no transfer tool when there are no transfer targets', async () => {
    const agent = new LlmAgent({
      name: 'lone_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });
    const llmRequest = createLlmRequest();

    await runProcessor(createMockInvocationContext(agent), llmRequest);

    expect(llmRequest.toolsDict['transfer_to_agent']).toBeUndefined();
    expect(llmRequest.config?.tools).toBeUndefined();
  });

  it('names the available agents in the instructions, sorted', async () => {
    const invocationContext = createMockInvocationContext(
      createAgentWithThreeTargets(),
    );
    const llmRequest = createLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      '**NOTE**: the only available agents for `transfer_to_agent` function are\n' +
        '`alpha_agent`, `mid_agent`, `zeta_agent`.',
    );
  });

  it('declares a separate target list for each agent', async () => {
    const firstAgent = new LlmAgent({
      name: 'first_root',
      model: 'gemini-2.5-flash',
      subAgents: [
        new LlmAgent({name: 'first_child', model: 'gemini-2.5-flash'}),
      ],
    });
    const secondAgent = new LlmAgent({
      name: 'second_root',
      model: 'gemini-2.5-flash',
      subAgents: [
        new LlmAgent({name: 'second_child', model: 'gemini-2.5-flash'}),
      ],
    });
    const firstRequest = createLlmRequest();
    const secondRequest = createLlmRequest();

    await runProcessor(createMockInvocationContext(firstAgent), firstRequest);
    await runProcessor(createMockInvocationContext(secondAgent), secondRequest);

    expect(transferDeclarationEnum(firstRequest)).toEqual(['first_child']);
    expect(transferDeclarationEnum(secondRequest)).toEqual(['second_child']);
  });
});
