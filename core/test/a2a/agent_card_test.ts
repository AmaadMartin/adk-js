/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {buildAgentSkills} from '../../src/a2a/agent_card.js';
import {logger} from '../../src/utils/logger.js';
import {node} from '../../src/workflow/node.js';
import {Workflow} from '../../src/workflow/workflow.js';

import {
  BaseAgent,
  BaseTool,
  BaseToolset,
  FunctionTool,
  getA2AAgentCard,
  LlmAgent,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';

// Minimal CustomAgent for testing BaseAgent path
class CustomAgent extends BaseAgent {
  constructor(name: string, description?: string, subAgents?: BaseAgent[]) {
    super({
      name,
      description,
      subAgents,
    });
  }

  protected async *runAsyncImpl() {
    yield* [];
  }

  protected async *runLiveImpl() {
    yield* [];
  }
}

class MockToolset extends BaseToolset {
  constructor(private readonly tools: BaseTool[]) {
    super([]);
  }
  async getTools() {
    return this.tools;
  }
  async close() {}
}

// Stands in for a toolset that enumerates its tools over the network and
// cannot reach the far end.
class RejectingToolset extends BaseToolset {
  constructor(private readonly error: unknown) {
    super([]);
  }
  async getTools(): Promise<BaseTool[]> {
    throw this.error;
  }
  async close() {}
}

describe('Agent Card', () => {
  const dummyTransport = {
    transport: 'grpc',
    url: 'grpc://localhost:8080',
  };

  describe('getA2AAgentCard', () => {
    it('creates a basic agent card for a custom agent', async () => {
      const agent = new CustomAgent('test_agent', 'A custom test agent');

      const card = await getA2AAgentCard(agent, [dummyTransport]);

      expect(card.name).toBe('test_agent');
      expect(card.description).toBe('A custom test agent');
      expect(card.url).toBe('grpc://localhost:8080');
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.skills).toHaveLength(1);

      const skill = card.skills[0];
      expect(skill.name).toBe('custom');
      expect(skill.id).toBe('test_agent');
      expect(skill.tags).toContain('custom_agent');
    });

    it('identifies LlmAgent and builds skills correctly', async () => {
      const tool1 = new FunctionTool({
        name: 'test_tool',
        description: 'Test tool 1',
        execute: async () => 'ok',
      });
      const toolset = new MockToolset([
        new FunctionTool({
          name: 'inner_tool',
          execute: async () => 'ok',
          description: 'Inner tool',
        }),
      ]);

      const agent = new LlmAgent({
        name: 'llm_agent',
        description: 'An LLM agent',
        instruction: 'You are a helpful assistant',
        tools: [tool1, toolset],
      });

      const card = await getA2AAgentCard(agent, [dummyTransport]);

      // Skills should include: the model itself, and tools
      expect(card.skills).toHaveLength(3); // 1 model + 1 tool1 + 1 inner_tool

      const modelSkill = card.skills.find((s) => s.name === 'model');
      expect(modelSkill).toBeDefined();
      expect(modelSkill?.description).toContain('I am a helpful assistant'); // pronoun replacement test

      const toolSkill = card.skills.find((s) => s.name === 'test_tool');
      expect(toolSkill).toBeDefined();
      expect(toolSkill?.description).toBe('Test tool 1');

      const innerToolSkill = card.skills.find((s) => s.name === 'inner_tool');
      expect(innerToolSkill).toBeDefined();
    });

    it('works with workflow agents and builds correct orchestration descriptions', async () => {
      const sub1 = new CustomAgent('sub1', 'fetch data');
      const sub2 = new CustomAgent('sub2', 'process data');

      const seqAgent = new SequentialAgent({
        name: 'seq_agent',
        subAgents: [sub1, sub2],
      });

      const card = await getA2AAgentCard(seqAgent, [dummyTransport]);
      expect(card.description).toBe('');
      expect(card.skills.length).toBeGreaterThan(1);

      const seqSkill = card.skills.find((s) => s.name === 'workflow');
      expect(seqSkill).toBeDefined();
      expect(seqSkill?.description).toBe(
        'First, this agent will fetch data. Finally, this agent will process data.',
      );

      const orchestrationSkill = card.skills.find(
        (s) => s.name === 'sub-agents',
      );
      expect(orchestrationSkill).toBeDefined();
      expect(orchestrationSkill?.description).toContain('fetch data');
    });
  });

  describe('buildAgentSkills', () => {
    it('handles dynamic instructions safely', async () => {
      const mockProvider = vi
        .fn()
        .mockResolvedValue('You are dynamically created');
      const agent = new LlmAgent({
        name: 'dyn_agent',
        instruction: mockProvider,
      });

      const skills = await buildAgentSkills(agent);
      const modelSkill = skills.find((s) => s.name === 'model');
      expect(modelSkill?.description).toContain('I am dynamically created');
    });

    it('handles dynamic instruction failure safely', async () => {
      const mockProvider = vi.fn().mockRejectedValue(new Error('fail'));
      const agent = new LlmAgent({
        name: 'dyn_agent_fail',
        description: 'Fallback desc',
        instruction: mockProvider,
      });

      const skills = await buildAgentSkills(agent);
      const modelSkill = skills.find((s) => s.name === 'model');
      // If instruction fails, it falls back to empty, but still uses description
      expect(modelSkill?.description).toContain('Fallback desc');
    });

    it('handles global instructions', async () => {
      const properRoot = new LlmAgent({
        name: 'root',
        globalInstruction: 'You are global',
        subAgents: [
          new LlmAgent({
            name: 'sub',
            instruction: 'You are sub',
          }),
        ],
      });

      const properlyWiredSub = properRoot.subAgents[0] as LlmAgent;

      const skills = await buildAgentSkills(properlyWiredSub);
      const modelSkill = skills.find((s) => s.name === 'model');

      expect(modelSkill?.description).toContain('I am sub');
      expect(modelSkill?.description).toContain('I am global');
    });

    it('supports parallel agent description', async () => {
      const sub1 = new CustomAgent('sub1', 'do A');
      const sub2 = new CustomAgent('sub2', 'do B');

      const parAgent = new ParallelAgent({
        name: 'par_agent',
        subAgents: [sub1, sub2],
      });

      const skills = await buildAgentSkills(parAgent);
      const workflowSkill = skills.find((s) => s.name === 'workflow');
      expect(workflowSkill?.description).toBe(
        'This agent will do A and do B simultaneously.',
      );
    });

    it('supports loop agent description', async () => {
      const sub1 = new CustomAgent('sub1', 'do A');
      const sub2 = new CustomAgent('sub2', 'do B');

      const loopAgent = new LoopAgent({
        name: 'loop_agent',
        subAgents: [sub1, sub2],
        maxIterations: 5,
      });

      const skills = await buildAgentSkills(loopAgent);
      const workflowSkill = skills.find((s) => s.name === 'workflow');
      expect(workflowSkill?.description).toBe(
        'This agent will do A and do B in a loop (max 5 iterations).',
      );
    });

    it('classifies a graph Workflow as a workflow, not a custom agent', async () => {
      const agent = new Workflow({
        name: 'graph_workflow',
        description: 'Runs a graph',
        edges: [['START', node(() => 'done', {name: 'step'})]],
      });

      const skills = await buildAgentSkills(agent);

      const workflowSkill = skills.find((s) => s.name === 'workflow');
      expect(workflowSkill?.description).toBe('Runs a graph');
      expect(skills.find((s) => s.name === 'custom')).toBeUndefined();
    });
  });

  describe('sub-agent skill build failures', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function rootWithFailingSubAgent(error: unknown): LlmAgent {
      return new LlmAgent({
        name: 'root',
        description: 'Root agent',
        tools: [
          new FunctionTool({
            name: 'root_tool',
            description: 'Root tool',
            execute: async () => 'ok',
          }),
        ],
        subAgents: [
          new LlmAgent({
            name: 'bad',
            description: 'Bad agent',
            tools: [new RejectingToolset(error)],
          }),
          new LlmAgent({name: 'good', description: 'Good agent'}),
        ],
      });
    }

    it('serves the card without the skills of a failing sub-agent', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const root = rootWithFailingSubAgent(new Error('toolset unreachable'));

      const card = await getA2AAgentCard(root, [dummyTransport]);

      expect(card.skills.map((s) => s.id)).toEqual([
        'root',
        'root-root_tool',
        'good_good',
      ]);
      expect(card.skills.some((s) => s.tags?.includes('sub_agent:bad'))).toBe(
        false,
      );
      expect(warnSpy).toHaveBeenCalled();
    });

    it('reports the failure once, naming the sub-agent', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const error = new Error('toolset unreachable');
      const root = rootWithFailingSubAgent(error);

      await getA2AAgentCard(root, [dummyTransport]);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to build skills for sub-agent bad',
        error,
      );
    });

    it('skips a sub-agent that rejects with a non-Error value', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const root = rootWithFailingSubAgent('toolset unreachable');

      const card = await getA2AAgentCard(root, [dummyTransport]);

      expect(card.skills.map((s) => s.id)).toEqual([
        'root',
        'root-root_tool',
        'good_good',
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to build skills for sub-agent bad',
        'toolset unreachable',
      );
    });

    it('leaves the skills of healthy sub-agents unchanged', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const root = new LlmAgent({
        name: 'root',
        description: 'Root agent',
        tools: [
          new FunctionTool({
            name: 'root_tool',
            description: 'Root tool',
            execute: async () => 'ok',
          }),
        ],
        subAgents: [
          new LlmAgent({name: 'alpha', description: 'Alpha agent'}),
          new LlmAgent({name: 'beta', description: 'Beta agent'}),
        ],
      });

      const skills = await buildAgentSkills(root);

      expect(skills).toEqual([
        {
          id: 'root',
          name: 'model',
          description: 'Root agent',
          tags: ['llm'],
        },
        {
          id: 'root-root_tool',
          name: 'root_tool',
          description: 'Root tool',
          tags: ['llm', 'tools'],
        },
        {
          id: 'alpha_alpha',
          name: 'alpha: model',
          description: 'Alpha agent',
          tags: ['sub_agent:alpha', 'llm'],
        },
        {
          id: 'beta_beta',
          name: 'beta: model',
          description: 'Beta agent',
          tags: ['sub_agent:beta', 'llm'],
        },
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('still rejects when the root agent itself cannot be described', async () => {
      const root = new LlmAgent({
        name: 'root',
        description: 'Root agent',
        tools: [new RejectingToolset(new Error('root toolset unreachable'))],
        subAgents: [new LlmAgent({name: 'good', description: 'Good agent'})],
      });

      await expect(getA2AAgentCard(root, [dummyTransport])).rejects.toThrow(
        'root toolset unreachable',
      );
    });
  });
});
