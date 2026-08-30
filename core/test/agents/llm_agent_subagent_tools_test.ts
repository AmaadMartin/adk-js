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

import {LlmAgent} from '../../src/agents/llm_agent.js';
import {
  SingleTurnAgentTool,
  TaskAgentTool,
} from '../../src/tools/agent_tool.js';
import {FunctionTool} from '../../src/tools/function_tool.js';

const TASK_WARNING_START =
  '\nIMPORTANT: This tool delegates execution to a specialized agent.';

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

  it('builds a coordinator from a freshly loaded module graph', async () => {
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
  });
});
