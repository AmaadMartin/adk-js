/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  FunctionTool,
  LlmAgent,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import {
  MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  getAgentGraphAsDot,
  getNodeCaption,
  getNodeShape,
} from '../../src/server/agent_graph.js';
import {AdkLogger} from '../../src/utils/logger.js';

describe('AgentGraph', () => {
  it('generates a DOT graph for a simple LlmAgent with a FunctionTool', async () => {
    const tool = new FunctionTool({
      name: 'testTool',
      description: 'a test tool',
      execute: async () => 'result',
    });
    const agent = new LlmAgent({
      name: 'testAgent',
      tools: [tool],
    });

    const dotGraph = await getAgentGraphAsDot(agent, []);
    expect(dotGraph).toContain('strict digraph "testAgent" {');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"testAgent"');
    expect(dotGraph).toContain('label = "🤖 testAgent"');
    expect(dotGraph).toContain('"testTool"');
    expect(dotGraph).toContain('label = "🔧 testTool"');
    expect(dotGraph).toContain('"testAgent" -> "testTool" [');
  });

  it('generates a DOT graph for a SequentialAgent', async () => {
    const tool1 = new FunctionTool({
      name: 'tool1',
      description: 'tool1',
      execute: async () => 'result',
    });
    const agent1 = new LlmAgent({
      name: 'agent1',
      tools: [tool1],
    });
    const tool2 = new FunctionTool({
      name: 'tool2',
      description: 'tool2',
      execute: async () => 'result',
    });
    const agent2 = new LlmAgent({
      name: 'agent2',
      tools: [tool2],
    });
    const sequentialAgent = new SequentialAgent({
      name: 'sequentialAgent',
      subAgents: [agent1, agent2],
    });

    const dotGraph = await getAgentGraphAsDot(sequentialAgent, []);
    expect(dotGraph).toContain('strict digraph "sequentialAgent"');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1"');
    expect(dotGraph).toContain('"tool1"');
    expect(dotGraph).toContain('label = "🔧 tool1"');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2"');
    expect(dotGraph).toContain('"tool2"');
    expect(dotGraph).toContain('label = "🔧 tool2"');
    expect(dotGraph).toContain('"agent1" -> "tool1"');
    expect(dotGraph).toContain('"agent2" -> "tool2"');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain(
      'subgraph "cluster_sequentialAgent (Sequential Agent)"',
    );
  });

  it('generates a DOT graph with highlighted edges', async () => {
    const agent1 = new LlmAgent({name: 'agent1'});
    const agent2 = new LlmAgent({name: 'agent2'});
    const sequentialAgent = new SequentialAgent({
      name: 'sequentialAgent',
      subAgents: [agent1, agent2],
    });

    const highlights: Array<[string, string]> = [['agent1', 'agent2']];
    const dotGraph = await getAgentGraphAsDot(sequentialAgent, highlights);

    expect(dotGraph).toContain('strict digraph "sequentialAgent"');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1"');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2"');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain(
      'subgraph "cluster_sequentialAgent (Sequential Agent)"',
    );
    expect(dotGraph).toContain(
      'label = "cluster_sequentialAgent (Sequential Agent)"',
    );
  });

  it('generates a DOT graph with highlighted nodes', async () => {
    const agent1 = new LlmAgent({name: 'agent1'});
    const agent2 = new LlmAgent({name: 'agent2'});
    const sequentialAgent = new SequentialAgent({
      name: 'sequentialAgent',
      subAgents: [agent1, agent2],
    });

    const highlights: Array<[string, string]> = [['agent1', 'agent3']];
    const dotGraph = await getAgentGraphAsDot(sequentialAgent, highlights);

    expect(dotGraph).toContain('strict digraph "sequentialAgent"');
    expect(dotGraph).toContain('rankdir = "LR";');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1";');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2";');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain('cluster_sequentialAgent (Sequential Agent)"');
    expect(dotGraph).toContain(
      'label = "cluster_sequentialAgent (Sequential Agent)"',
    );
  });

  it('generates a DOT graph for a LoopAgent', async () => {
    const tool1 = new FunctionTool({
      name: 'tool1',
      description: 'tool1',
      execute: async () => 'result',
    });
    const agent1 = new LlmAgent({
      name: 'agent1',
      tools: [tool1],
    });
    const tool2 = new FunctionTool({
      name: 'tool2',
      description: 'tool2',
      execute: async () => 'result',
    });
    const agent2 = new LlmAgent({
      name: 'agent2',
      tools: [tool2],
    });
    const loopAgent = new LoopAgent({
      name: 'loopAgent',
      subAgents: [agent1, agent2],
    });

    const dotGraph = await getAgentGraphAsDot(loopAgent, []);
    expect(dotGraph).toContain('strict digraph "loopAgent"');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1"');
    expect(dotGraph).toContain('"tool1"');
    expect(dotGraph).toContain('label = "🔧 tool1"');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2"');
    expect(dotGraph).toContain('"tool2"');
    expect(dotGraph).toContain('label = "🔧 tool2"');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain('"agent2" -> "agent1"');
    expect(dotGraph).toContain('"agent1" -> "tool1"');
    expect(dotGraph).toContain('"agent2" -> "tool2"');
    expect(dotGraph).toContain('subgraph "cluster_loopAgent (Loop Agent)"');
    expect(dotGraph).toContain('label = "cluster_loopAgent (Loop Agent)"');
  });

  it('generates a DOT graph for a ParallelAgent', async () => {
    const tool1 = new FunctionTool({
      name: 'tool1',
      description: 'tool1',
      execute: async () => 'result',
    });
    const agent1 = new LlmAgent({
      name: 'agent1',
      tools: [tool1],
    });
    const tool2 = new FunctionTool({
      name: 'tool2',
      description: 'tool2',
      execute: async () => 'result',
    });
    const agent2 = new LlmAgent({
      name: 'agent2',
      tools: [tool2],
    });
    const parallelAgent = new ParallelAgent({
      name: 'parallelAgent',
      subAgents: [agent1, agent2],
    });

    const dotGraph = await getAgentGraphAsDot(parallelAgent, []);
    expect(dotGraph).toContain('strict digraph "parallelAgent"');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1"');
    expect(dotGraph).toContain('"tool1"');
    expect(dotGraph).toContain('label = "🔧 tool1"');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2"');
    expect(dotGraph).toContain('"tool2"');
    expect(dotGraph).toContain('label = "🔧 tool2"');
    expect(dotGraph).toContain('"agent1" -> "tool1"');
    expect(dotGraph).toContain('"agent2" -> "tool2"');
    expect(dotGraph).toContain(
      'subgraph "cluster_parallelAgent (Parallel Agent)"',
    );
    expect(dotGraph).toContain(
      'label = "cluster_parallelAgent (Parallel Agent)"',
    );
  });

  describe('unsupported tool type diagnostics', () => {
    // The fallback branches only run for a value that is neither a BaseAgent
    // nor a BaseTool, which the parameter type rules out.
    const unsupported = {name: 'mysteryTool'} as unknown as BaseTool;

    let warnSpy: MockInstance<AdkLogger['warn']>;
    let consoleWarnSpy: MockInstance<typeof console.warn>;

    beforeEach(() => {
      warnSpy = vi
        .spyOn(AdkLogger.prototype, 'warn')
        .mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('getNodeCaption logs the diagnostic through AdkLogger', () => {
      expect(getNodeCaption(unsupported)).toBe(
        '❓ Unsupported tool type: object',
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('Unsupported tool type: object');
    });

    it('getNodeShape logs the diagnostic through AdkLogger', () => {
      expect(getNodeShape(unsupported)).toBe('cylinder');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('Unsupported tool type: object');
    });

    it('does not write the diagnostic to console.warn', () => {
      getNodeCaption(unsupported);
      getNodeShape(unsupported);

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('does not warn about a supported tool', () => {
      const tool = new FunctionTool({
        name: 'testTool',
        description: 'a test tool',
        execute: async () => 'result',
      });

      expect(getNodeCaption(tool)).toBe('🔧 testTool');
      expect(getNodeShape(tool)).toBe('box');
      expect(warnSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });
});
