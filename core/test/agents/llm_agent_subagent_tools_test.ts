/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A sub-agent that declares an execution `mode` reaches the parent model as a
 * callable tool instead of as a transfer target. Mirrors adk-python's
 * `tests/unittests/agents/test_llm_agent_single_turn_subagents.py`.
 */

import {describe, expect, it} from 'vitest';

import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {AgentTransferLlmRequestProcessor} from '../../src/agents/processors/agent_transfer_llm_request_processor.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {
  SingleTurnAgentTool,
  TaskAgentTool,
} from '../../src/tools/agent_tool.js';
import {FunctionTool} from '../../src/tools/function_tool.js';

const TASK_WARNING_START =
  '\nIMPORTANT: This tool delegates execution to a specialized agent.';

/**
 * Budget for the module-cycle case, which loads the whole `@google/adk` barrel
 * through the transform pipeline. That exceeds the 5s default when the suite
 * runs in parallel.
 */
const MODULE_LOAD_TIMEOUT_MS = 30_000;

/** The transfer instructions the processor gives `agent`, if any. */
async function transferInstructions(agent: BaseAgent): Promise<string> {
  const llmRequest: LlmRequest = {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent,
    session: createSession({id: 's1', appName: 'app', userId: 'u'}),
    pluginManager: new PluginManager([]),
  });
  const processor = new AgentTransferLlmRequestProcessor();
  for await (const _event of processor.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // The processor only mutates the request.
  }
  const instruction = llmRequest.config?.systemInstruction;
  return typeof instruction === 'string' ? instruction : '';
}

describe('LlmAgent sub-agent delegation tools', () => {
  it('wraps a single_turn sub-agent as a SingleTurnAgentTool', () => {
    const coder = new LlmAgent({
      name: 'coder',
      description: 'Writes a small code change.',
      mode: 'single_turn',
    });

    const coordinator = new LlmAgent({name: 'coordinator', subAgents: [coder]});

    expect(coordinator.tools).toHaveLength(1);
    const [tool] = coordinator.tools;
    expect(tool).toBeInstanceOf(SingleTurnAgentTool);
    expect((tool as SingleTurnAgentTool).name).toBe('coder');
    expect((tool as SingleTurnAgentTool)._getDeclaration()?.description).toBe(
      'Writes a small code change.',
    );
  });

  it('wraps a task sub-agent as a TaskAgentTool', () => {
    const specialist = new LlmAgent({
      name: 'specialist',
      description: 'Finishes a delegated task.',
      mode: 'task',
    });

    const coordinator = new LlmAgent({
      name: 'coordinator',
      subAgents: [specialist],
    });

    expect(coordinator.tools).toHaveLength(1);
    const [tool] = coordinator.tools;
    expect(tool).toBeInstanceOf(TaskAgentTool);
    expect((tool as TaskAgentTool)._getDeclaration()?.description).toBe(
      `Finishes a delegated task.${TASK_WARNING_START}` +
        ' Do NOT call this tool in parallel with any other tools.',
    );
  });

  it('leaves a sub-agent that declares no mode unwrapped', () => {
    const helper = new LlmAgent({name: 'helper', description: 'Chats.'});

    const coordinator = new LlmAgent({
      name: 'coordinator',
      subAgents: [helper],
    });

    expect(coordinator.tools).toEqual([]);
  });

  it('appends the wrappers after the tools the caller supplied', () => {
    const coder = new LlmAgent({
      name: 'coder',
      description: 'Writes a small code change.',
      mode: 'single_turn',
    });
    const ownTool = new FunctionTool({
      name: 'ping',
      description: 'Pings.',
      execute: () => 'pong',
    });
    const suppliedTools = [ownTool];

    const coordinator = new LlmAgent({
      name: 'coordinator',
      tools: suppliedTools,
      subAgents: [coder],
    });

    expect(coordinator.tools).toHaveLength(2);
    expect(coordinator.tools[0]).toBe(ownTool);
    // The caller's own array must not collect the wrapper: a second agent built
    // from it would otherwise get the first agent's sub-agent tools too.
    expect(suppliedTools).toEqual([ownTool]);
  });

  it('keeps the caller tools array private when no sub-agent has a mode', () => {
    const ownTool = new FunctionTool({
      name: 'ping',
      description: 'Pings.',
      execute: () => 'pong',
    });
    const suppliedTools = [ownTool];

    const agent = new LlmAgent({name: 'solo', tools: suppliedTools});
    // ADK pushes into `tools` after construction — SequentialAgent adds its
    // task-completed tool to a sub-agent. That must not reach the caller.
    agent.tools.push(
      new FunctionTool({
        name: 'added_later',
        description: 'Added by the framework.',
        execute: () => 'ok',
      }),
    );

    expect(suppliedTools).toEqual([ownTool]);
  });

  it(
    'builds a coordinator from a freshly loaded module graph',
    async () => {
      const adk = await import('@google/adk');

      const coder = new adk.LlmAgent({
        name: 'coder',
        description: 'Writes a small code change.',
        mode: 'single_turn',
      });
      const coordinator = new adk.LlmAgent({
        name: 'coordinator',
        subAgents: [coder],
      });

      expect(coordinator.tools).toHaveLength(1);
      expect(coordinator.tools[0]).toBeInstanceOf(adk.SingleTurnAgentTool);
    },
    MODULE_LOAD_TIMEOUT_MS,
  );
});

describe('LlmAgent sub-agent transfer targets', () => {
  it('offers a sub-agent that declares no mode', async () => {
    const chatty = new LlmAgent({name: 'chatty', description: 'Chats.'});
    const coordinator = new LlmAgent({
      name: 'coordinator',
      subAgents: [chatty],
    });

    expect(await transferInstructions(coordinator)).toContain(
      'Agent name: chatty',
    );
  });

  it('withholds a single_turn sub-agent and keeps its peer', async () => {
    const coder = new LlmAgent({
      name: 'coder',
      description: 'Writes a small code change.',
      mode: 'single_turn',
    });
    const chatty = new LlmAgent({name: 'chatty', description: 'Chats.'});
    const coordinator = new LlmAgent({
      name: 'coordinator',
      subAgents: [coder, chatty],
    });

    const instructions = await transferInstructions(coordinator);
    expect(instructions).not.toContain('Agent name: coder');
    expect(instructions).toContain('Agent name: chatty');
  });

  it('withholds a task sub-agent', async () => {
    const specialist = new LlmAgent({
      name: 'specialist',
      description: 'Finishes a delegated task.',
      mode: 'task',
    });
    const chatty = new LlmAgent({name: 'chatty', description: 'Chats.'});
    const coordinator = new LlmAgent({
      name: 'coordinator',
      subAgents: [specialist, chatty],
    });

    expect(await transferInstructions(coordinator)).not.toContain(
      'Agent name: specialist',
    );
  });

  it('withholds a peer that declares a mode', async () => {
    const coder = new LlmAgent({
      name: 'coder',
      description: 'Writes a small code change.',
      mode: 'single_turn',
    });
    const chatty = new LlmAgent({name: 'chatty', description: 'Chats.'});
    const reviewer = new LlmAgent({name: 'reviewer', description: 'Reviews.'});
    new LlmAgent({
      name: 'coordinator',
      description: 'Coordinates.',
      subAgents: [coder, chatty, reviewer],
    });

    const instructions = await transferInstructions(chatty);
    expect(instructions).not.toContain('Agent name: coder');
    expect(instructions).toContain('Agent name: reviewer');
    expect(instructions).toContain('Agent name: coordinator');
  });

  it('gives no transfer instructions when every sub-agent declares a mode', async () => {
    const coder = new LlmAgent({
      name: 'coder',
      description: 'Writes a small code change.',
      mode: 'single_turn',
    });
    const coordinator = new LlmAgent({
      name: 'coordinator',
      subAgents: [coder],
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });

    expect(await transferInstructions(coordinator)).toBe('');
  });
});
