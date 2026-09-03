/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the constructor-injected configuration, which the adk-js conformance
 * test runner uses and adk-python's plugin has no counterpart for.
 */

import {
  AgentTool,
  AgentTransferLlmRequestProcessor,
  BaseAgent,
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  RunAsyncToolRequest,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  ReplayPlugin,
  ReplayVerificationError,
} from '../../src/integration/replay_plugin.js';
import {Recording} from '../../src/integration/test_types.js';

/** Tool that records the args it was actually executed with. */
class SpyTool extends BaseTool {
  readonly liveCalls: Array<Record<string, unknown>> = [];

  constructor(name = 'roll_die') {
    super({name, description: 'test tool'});
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    this.liveCalls.push(args);
    return {result: 'live'};
  }
}

/** AgentTool that reports whether the plugin re-drove its sub-agent. */
class SpyAgentTool extends AgentTool {
  ran = false;

  override async runAsync(): Promise<unknown> {
    this.ran = true;
    return {};
  }
}

function toolRecording(
  options: {
    agentName?: string;
    userMessageIndex?: number;
    toolName?: string;
    args?: Record<string, unknown>;
    response?: Record<string, unknown>;
  } = {},
): Recording {
  const {
    agentName = 'agent_a',
    userMessageIndex = 0,
    toolName = 'roll_die',
    args = {sides: 6},
    response = {result: 4},
  } = options;
  return {
    userMessageIndex,
    agentName,
    toolRecording: {
      toolCall: {name: toolName, args},
      toolResponse: {name: toolName, response},
    },
  };
}

/** A recording of a tool the model called without any argument. */
function noArgsRecording(): Recording {
  return {
    userMessageIndex: 0,
    agentName: 'agent_a',
    toolRecording: {
      toolCall: {name: 'roll_die'},
      toolResponse: {name: 'roll_die', response: {result: 4}},
    },
  };
}

function llmRecording(text: string, agentName = 'agent_a'): Recording {
  return {
    userMessageIndex: 0,
    agentName,
    llmRecording: {
      llmResponse: {content: {role: 'model', parts: [{text}]}},
    },
  };
}

function makeContext(
  agentName = 'agent_a',
  subAgents: BaseAgent[] = [],
): Context {
  const session = createSession({id: 'test-session', appName: 'test-app'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: agentName, subAgents}),
      session,
      pluginManager: new PluginManager([]),
    }),
  });
}

/** The `transfer_to_agent` tool the framework itself registers on a request. */
async function realTransferTool(
  invocationContext: InvocationContext,
): Promise<BaseTool> {
  const llmRequest: LlmRequest = {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
  };
  for await (const event of new AgentTransferLlmRequestProcessor().runAsync(
    invocationContext,
    llmRequest,
  )) {
    expect.fail(`the processor yielded an unexpected event: ${event.id}`);
  }
  const tool = llmRequest.toolsDict['transfer_to_agent'];
  if (!tool) {
    expect.fail('the processor did not register the transfer tool');
  }
  return tool;
}

const EMPTY_LLM_REQUEST: LlmRequest = {
  contents: [],
  liveConnectConfig: {},
  toolsDict: {},
};

describe('ReplayPlugin injected recordings', () => {
  it('should replay the recorded response and run the tool', async () => {
    const plugin = new ReplayPlugin([toolRecording()], {userMessageIndex: 0});
    const context = makeContext();
    const tool = new SpyTool();

    await plugin.beforeRunCallback({
      invocationContext: context.invocationContext,
    });
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: context,
    });

    expect(replayed).toEqual({result: 4});
    expect(tool.liveCalls).toEqual([{sides: 6}]);
  });

  it('should reject an argument that does not match the recording', async () => {
    const plugin = new ReplayPlugin([toolRecording({args: {sides: 6}})], {
      userMessageIndex: 0,
    });
    const context = makeContext();

    await plugin.beforeRunCallback({
      invocationContext: context.invocationContext,
    });
    await expect(
      plugin.beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 20},
        toolContext: context,
      }),
    ).rejects.toBeInstanceOf(ReplayVerificationError);
  });

  it('should accept an empty call against a recording with no arguments', async () => {
    const plugin = new ReplayPlugin([noArgsRecording()], {userMessageIndex: 0});
    const context = makeContext();

    await plugin.beforeRunCallback({
      invocationContext: context.invocationContext,
    });
    const replayed = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {},
      toolContext: context,
    });

    expect(replayed).toEqual({result: 4});
  });

  it('should render an absent recorded argument list as empty', async () => {
    const plugin = new ReplayPlugin([noArgsRecording()], {userMessageIndex: 0});
    const context = makeContext();

    await plugin.beforeRunCallback({
      invocationContext: context.invocationContext,
    });
    const error = await plugin
      .beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 6},
        toolContext: context,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReplayVerificationError);
    expect(String(error)).toContain('recorded: {}\ncurrent: {"sides":6}');
  });

  it('should reject a recording that holds no response', async () => {
    const plugin = new ReplayPlugin(
      [
        {
          userMessageIndex: 0,
          agentName: 'agent_a',
          toolRecording: {toolCall: {name: 'roll_die', args: {sides: 6}}},
        },
      ],
      {userMessageIndex: 0},
    );
    const context = makeContext();

    await plugin.beforeRunCallback({
      invocationContext: context.invocationContext,
    });
    const error = await plugin
      .beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 6},
        toolContext: context,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReplayVerificationError);
    expect(error).toHaveProperty(
      'message',
      "Tool recording for agent 'agent_a' at index 0 holds no response for" +
        " 'roll_die'",
    );
  });

  it('should still transfer to the recorded agent', async () => {
    const plugin = new ReplayPlugin(
      [
        toolRecording({
          toolName: 'transfer_to_agent',
          args: {agentName: 'agent_b'},
          response: {result: 'transferred'},
        }),
      ],
      {userMessageIndex: 0},
    );
    const context = makeContext('agent_a', [new LlmAgent({name: 'agent_b'})]);
    const transferTool = await realTransferTool(context.invocationContext);

    await plugin.beforeRunCallback({
      invocationContext: context.invocationContext,
    });
    await plugin.beforeToolCallback({
      tool: transferTool,
      toolArgs: {agentName: 'agent_b'},
      toolContext: context,
    });

    // The plugin holds no transfer special case: running the real tool is what
    // sets the action.
    expect(context.actions.transferToAgent).toBe('agent_b');
  });

  it('should not re-drive the sub-agent behind an AgentTool', async () => {
    const agentTool = new SpyAgentTool({agent: new LlmAgent({name: 'helper'})});
    const plugin = new ReplayPlugin(
      [toolRecording({toolName: 'helper', args: {request: 'hi'}})],
      {userMessageIndex: 0},
    );
    const context = makeContext();

    await plugin.beforeRunCallback({
      invocationContext: context.invocationContext,
    });
    const replayed = await plugin.beforeToolCallback({
      tool: agentTool,
      toolArgs: {request: 'hi'},
      toolContext: context,
    });

    expect(agentTool.ran).toBe(false);
    expect(replayed).toEqual({result: 4});
  });

  it('should serve each LLM recording once', async () => {
    const plugin = new ReplayPlugin(
      [llmRecording('first'), llmRecording('second')],
      {userMessageIndex: 0},
    );
    const callbackContext = makeContext();

    const first = await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: EMPTY_LLM_REQUEST,
    });
    const second = await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: EMPTY_LLM_REQUEST,
    });

    expect(first?.content?.parts?.[0].text).toBe('first');
    expect(second?.content?.parts?.[0].text).toBe('second');
  });

  it('should fail once the LLM recordings run out', async () => {
    const plugin = new ReplayPlugin([llmRecording('only')], {
      userMessageIndex: 0,
    });
    const callbackContext = makeContext();

    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: EMPTY_LLM_REQUEST,
    });

    await expect(
      plugin.beforeModelCallback({
        callbackContext,
        llmRequest: EMPTY_LLM_REQUEST,
      }),
    ).rejects.toThrowError(
      'No LLM recording found for agent agent_a at turn 0',
    );
  });

  it('should leave the model call alone without injected recordings', async () => {
    const plugin = new ReplayPlugin();

    const replayed = await plugin.beforeModelCallback({
      callbackContext: makeContext(),
      llmRequest: EMPTY_LLM_REQUEST,
    });

    expect(replayed).toBeUndefined();
  });
});
