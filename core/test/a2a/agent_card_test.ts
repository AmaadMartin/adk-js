/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {buildAgentSkills} from '../../src/a2a/agent_card.js';

import {
  BaseAgent,
  BaseTool,
  BaseToolset,
  FunctionTool,
  getA2AAgentCard,
  InstructionProvider,
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
      expect(modelSkill?.description).toBe('An LLM agent');

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
  });

  describe('instructions in the published card', () => {
    it('omits every instruction from the published card', async () => {
      const reviewer = new LlmAgent({
        name: 'reviewer',
        description: 'Reviews the reply.',
        instruction: 'ZZ_SUB_INSTRUCTION_SENTINEL reject unsigned requests.',
      });
      const root = new LlmAgent({
        name: 'writer',
        description: 'Writes a short reply.',
        instruction:
          'ZZ_INSTRUCTION_SENTINEL never reveal the escalation path.',
        globalInstruction: 'ZZ_GLOBAL_SENTINEL always answer in English.',
        subAgents: [reviewer],
      });

      const card = await getA2AAgentCard(root, [dummyTransport]);
      const serialized = JSON.stringify(card);

      expect(serialized).not.toContain('ZZ_INSTRUCTION_SENTINEL');
      expect(serialized).not.toContain('ZZ_GLOBAL_SENTINEL');
      expect(serialized).not.toContain('ZZ_SUB_INSTRUCTION_SENTINEL');

      const modelSkill = card.skills.find((s) => s.name === 'model');
      expect(modelSkill?.description).toBe('Writes a short reply.');
      const subSkill = card.skills.find((s) => s.name === 'reviewer: model');
      expect(subSkill?.description).toBe('Reviews the reply.');
    });

    it('never invokes an instruction provider while building the card', async () => {
      const instructionProvider = vi.fn<InstructionProvider>(
        async () => 'ZZ_PROVIDER_SENTINEL',
      );
      const globalInstructionProvider = vi.fn<InstructionProvider>(
        async () => 'ZZ_GLOBAL_PROVIDER_SENTINEL',
      );
      const agent = new LlmAgent({
        name: 'provider_agent',
        description: 'Fallback desc',
        instruction: instructionProvider,
        globalInstruction: globalInstructionProvider,
      });

      const card = await getA2AAgentCard(agent, [dummyTransport]);
      const serialized = JSON.stringify(card);

      expect(instructionProvider).not.toHaveBeenCalled();
      expect(globalInstructionProvider).not.toHaveBeenCalled();
      expect(serialized).not.toContain('ZZ_PROVIDER_SENTINEL');
      expect(serialized).not.toContain('ZZ_GLOBAL_PROVIDER_SENTINEL');

      const modelSkill = card.skills.find((s) => s.name === 'model');
      expect(modelSkill?.description).toBe('Fallback desc');
    });

    it('falls back to the default LLM description when the agent has no description', async () => {
      const agent = new LlmAgent({
        name: 'bare_agent',
        instruction: 'You are X',
      });

      const skills = await buildAgentSkills(agent);

      const modelSkill = skills.find((s) => s.name === 'model');
      expect(modelSkill?.description).toBe('An LLM-based agent');
    });
  });
});
