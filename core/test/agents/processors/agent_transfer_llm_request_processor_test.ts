/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTransferLlmRequestProcessor,
  BaseAgent,
  BaseTool,
  BaseToolset,
  Context,
  createSession,
  EnterpriseWebSearchTool,
  FunctionTool,
  GoogleSearchTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LoopAgent,
  ParallelAgent,
  PluginManager,
  SequentialAgent,
  ToolUnion,
  VertexAiSearchTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const MODEL = 'gemini-2.5-flash';

/** A toolset holding a built-in search tool, to prove the scan skips toolsets. */
class SearchToolset extends BaseToolset {
  constructor() {
    super([]);
  }

  async getTools(): Promise<BaseTool[]> {
    return [new GoogleSearchTool()];
  }

  async close(): Promise<void> {}
}

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
});

async function runProcessor(agent: BaseAgent): Promise<LlmRequest> {
  const llmRequest: LlmRequest = {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };

  for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
    createMockInvocationContext(agent),
    llmRequest,
  )) {
    // Do nothing
  }

  return llmRequest;
}

function llmAgent(name: string, description = `${name} description`): LlmAgent {
  return new LlmAgent({name, model: MODEL, description});
}

describe('AgentTransferLlmRequestProcessor target filtering', () => {
  it('drops a single_turn sub-agent from the targets', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: MODEL,
      subAgents: [
        new LlmAgent({
          name: 'node_sub',
          model: MODEL,
          description: 'Node sub-agent',
          mode: 'single_turn',
        }),
        llmAgent('chat_sub'),
      ],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toContain('Agent name: chat_sub');
    expect(instruction).not.toContain('node_sub');
  });

  it('drops a task sub-agent from the targets', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: MODEL,
      subAgents: [
        new LlmAgent({
          name: 'node_sub',
          model: MODEL,
          description: 'Node sub-agent',
          mode: 'task',
        }),
        llmAgent('chat_sub'),
      ],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toContain('Agent name: chat_sub');
    expect(instruction).not.toContain('node_sub');
  });

  it('drops a single_turn peer from the targets', async () => {
    const agent = llmAgent('main_agent');
    new LlmAgent({
      name: 'parent_agent',
      model: MODEL,
      description: 'Parent agent',
      subAgents: [
        agent,
        new LlmAgent({
          name: 'node_peer',
          model: MODEL,
          description: 'Node peer',
          mode: 'single_turn',
        }),
        llmAgent('chat_peer'),
      ],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toContain('Agent name: chat_peer');
    expect(instruction).not.toContain('node_peer');
  });

  it('drops a task peer from the targets', async () => {
    const agent = llmAgent('main_agent');
    new LlmAgent({
      name: 'parent_agent',
      model: MODEL,
      description: 'Parent agent',
      subAgents: [
        agent,
        new LlmAgent({
          name: 'node_peer',
          model: MODEL,
          description: 'Node peer',
          mode: 'task',
        }),
        llmAgent('chat_peer'),
      ],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toContain('Agent name: chat_peer');
    expect(instruction).not.toContain('node_peer');
  });

  it('keeps workflow agent peers, which carry no mode', async () => {
    const agent = llmAgent('main_agent');
    new LlmAgent({
      name: 'parent_agent',
      model: MODEL,
      description: 'Parent agent',
      subAgents: [
        agent,
        new LoopAgent({name: 'loop_peer', description: 'Loop peer'}),
        new SequentialAgent({name: 'seq_peer', description: 'Seq peer'}),
        new ParallelAgent({name: 'par_peer', description: 'Par peer'}),
      ],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toContain('Agent name: loop_peer');
    expect(instruction).toContain('Agent name: seq_peer');
    expect(instruction).toContain('Agent name: par_peer');
  });

  it('keeps a workflow agent sub-agent', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: MODEL,
      subAgents: [new LoopAgent({name: 'loop_sub', description: 'Loop sub'})],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toContain('Agent name: loop_sub');
  });

  it('registers nothing when every sub-agent is filtered out', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: MODEL,
      subAgents: [
        new LlmAgent({
          name: 'node_sub',
          model: MODEL,
          description: 'Node sub-agent',
          mode: 'task',
        }),
      ],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeUndefined();
  });

  it('keeps a task-mode parent as a target', async () => {
    const agent = llmAgent('main_agent');
    new LlmAgent({
      name: 'parent_agent',
      model: MODEL,
      description: 'Parent agent',
      mode: 'task',
      subAgents: [agent],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toContain('Agent name: parent_agent');
    expect(instruction).toContain(
      '**NOTE**: the only available agents for `transfer_to_agent` function are\n`parent_agent`.',
    );
  });
});

describe('AgentTransferLlmRequestProcessor instruction text', () => {
  it('lists targets in declaration order and the NOTE names sorted', async () => {
    const agent = new LlmAgent({
      name: 'main_agent',
      model: MODEL,
      description: 'Main coordinating agent',
      subAgents: [
        llmAgent('z_agent', 'Last agent'),
        llmAgent('a_agent', 'First agent'),
        llmAgent('m_agent', 'Middle agent'),
      ],
    });
    new LlmAgent({
      name: 'parent_agent',
      model: MODEL,
      description: 'Parent agent',
      subAgents: [agent, llmAgent('peer_agent', 'Peer agent')],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toBe(`
You have a list of other agents to transfer to:


Agent name: z_agent
Agent description: Last agent


Agent name: a_agent
Agent description: First agent


Agent name: m_agent
Agent description: Middle agent


Agent name: parent_agent
Agent description: Parent agent


Agent name: peer_agent
Agent description: Peer agent


If you are the best to answer the question according to your description,
you can answer it.

If another agent is better for answering the question according to its
description, call \`transfer_to_agent\` function to transfer the question to that
agent. When transferring, do not generate any text other than the function
call.

**NOTE**: the only available agents for \`transfer_to_agent\` function are
\`a_agent\`, \`m_agent\`, \`parent_agent\`, \`peer_agent\`, \`z_agent\`.

If neither you nor the other agents are best for the question, transfer to your parent agent parent_agent.
`);
  });

  it('omits the parent sentence when the agent has no parent', async () => {
    const agent = new LlmAgent({
      name: 'main_agent',
      model: MODEL,
      description: 'Main agent without parent',
      subAgents: [
        llmAgent('agent1', 'First sub-agent'),
        llmAgent('agent2', 'Second sub-agent'),
      ],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toBe(`
You have a list of other agents to transfer to:


Agent name: agent1
Agent description: First sub-agent


Agent name: agent2
Agent description: Second sub-agent


If you are the best to answer the question according to your description,
you can answer it.

If another agent is better for answering the question according to its
description, call \`transfer_to_agent\` function to transfer the question to that
agent. When transferring, do not generate any text other than the function
call.

**NOTE**: the only available agents for \`transfer_to_agent\` function are
\`agent1\`, \`agent2\`.
`);
  });

  it('ends with the parent sentence when a parent is reachable', async () => {
    const agent = new LlmAgent({
      name: 'main_agent',
      model: MODEL,
      description: 'Main agent with parent',
      subAgents: [llmAgent('sub_agent', 'Sub agent')],
    });
    new LlmAgent({
      name: 'parent_agent',
      model: MODEL,
      description: 'Parent agent',
      subAgents: [agent],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toBe(`
You have a list of other agents to transfer to:


Agent name: sub_agent
Agent description: Sub agent


Agent name: parent_agent
Agent description: Parent agent


If you are the best to answer the question according to your description,
you can answer it.

If another agent is better for answering the question according to its
description, call \`transfer_to_agent\` function to transfer the question to that
agent. When transferring, do not generate any text other than the function
call.

**NOTE**: the only available agents for \`transfer_to_agent\` function are
\`parent_agent\`, \`sub_agent\`.

If neither you nor the other agents are best for the question, transfer to your parent agent parent_agent.
`);
  });

  it('names a non-LlmAgent peer, which carries no mode', async () => {
    const agent = llmAgent('main_agent');
    new LlmAgent({
      name: 'parent_agent',
      model: MODEL,
      description: 'Parent agent',
      subAgents: [agent, new MockRootAgent('mock_peer', 'Mock peer')],
    });

    const instruction = (await runProcessor(agent)).config?.systemInstruction;

    expect(instruction).toContain('Agent name: mock_peer');
    expect(instruction).toContain(
      '**NOTE**: the only available agents for `transfer_to_agent` function are\n`mock_peer`, `parent_agent`.',
    );
  });
});

describe('AgentTransferLlmRequestProcessor current agent mode', () => {
  it('appends no instructions for a task agent but still registers the tool', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: MODEL,
      mode: 'task',
      subAgents: [llmAgent('chat_sub')],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });

  it('appends no instructions for a single_turn agent but still registers the tool', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: MODEL,
      mode: 'single_turn',
      subAgents: [llmAgent('chat_sub')],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });
});

describe('AgentTransferLlmRequestProcessor incompatible built-in tools', () => {
  const SEARCH_TOOL_ERROR =
    "Agent 'root_agent' has sub-agent transfer targets but is configured " +
    'with GoogleSearchTool without bypassMultiToolsLimit: true. Gemini API ' +
    'does not allow built-in search tools to be combined with function ' +
    'calling (agent delegation). To enable both search and sub-agent ' +
    'delegation, set bypassMultiToolsLimit: true on GoogleSearchTool or ' +
    'VertexAiSearchTool.';

  function agentWithTools(tools: ToolUnion[]): LlmAgent {
    return new LlmAgent({
      name: 'root_agent',
      model: MODEL,
      tools,
      subAgents: [llmAgent('chat_sub')],
    });
  }

  it('throws when GoogleSearchTool meets a sub-agent target', async () => {
    const agent = agentWithTools([new GoogleSearchTool()]);

    await expect(runProcessor(agent)).rejects.toThrow(SEARCH_TOOL_ERROR);
  });

  it('accepts GoogleSearchTool with bypassMultiToolsLimit', async () => {
    const agent = agentWithTools([
      new GoogleSearchTool({bypassMultiToolsLimit: true}),
    ]);

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: chat_sub',
    );
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });

  it('throws when VertexAiSearchTool meets a sub-agent target', async () => {
    const agent = agentWithTools([
      new VertexAiSearchTool({dataStoreId: 'test-data-store'}),
    ]);

    await expect(runProcessor(agent)).rejects.toThrow(
      SEARCH_TOOL_ERROR.replace(
        'with GoogleSearchTool without',
        'with VertexAiSearchTool without',
      ),
    );
  });

  it('accepts VertexAiSearchTool with bypassMultiToolsLimit', async () => {
    const agent = agentWithTools([
      new VertexAiSearchTool({
        dataStoreId: 'test-data-store',
        bypassMultiToolsLimit: true,
      }),
    ]);

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });

  it('throws when EnterpriseWebSearchTool meets a sub-agent target', async () => {
    const agent = agentWithTools([new EnterpriseWebSearchTool()]);

    await expect(runProcessor(agent)).rejects.toThrow(
      "Agent 'root_agent' has sub-agent transfer targets but is configured " +
        'with EnterpriseWebSearchTool. Gemini API does not allow ' +
        'EnterpriseWebSearchTool to be combined with function calling (agent ' +
        'delegation).',
    );
  });

  it('registers nothing when only a parent and a peer are reachable', async () => {
    const agent = new LlmAgent({
      name: 'main_agent',
      model: MODEL,
      description: 'Main agent',
      tools: [new GoogleSearchTool()],
    });
    new LlmAgent({
      name: 'parent_agent',
      model: MODEL,
      description: 'Parent agent',
      subAgents: [agent, llmAgent('peer_agent')],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeUndefined();
  });

  it('does not throw when the agent has no transfer targets at all', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: MODEL,
      tools: [new GoogleSearchTool()],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeUndefined();
  });

  it('ignores a tool that is not a built-in search tool', async () => {
    const benignTool = new FunctionTool({
      name: 'echo',
      description: 'Echoes its input.',
      parameters: z.object({text: z.string()}),
      execute: (args: {text: string}) => args.text,
    });
    const agent = agentWithTools([benignTool]);

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });

  it('ignores a toolset, which the raw tool scan does not resolve', async () => {
    const agent = agentWithTools([new SearchToolset()]);

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });
});
