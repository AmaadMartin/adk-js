/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {buildAgentSkills} from '../../src/a2a/agent_card.js';
import {node} from '../../src/workflow/node.js';
import {Workflow} from '../../src/workflow/workflow.js';

import {AgentSkill} from '@a2a-js/sdk';
import {
  BaseAgent,
  BaseExampleProvider,
  BaseTool,
  BaseToolset,
  BuiltInCodeExecutor,
  Example,
  ExampleTool,
  FunctionTool,
  getA2AAgentCard,
  LlmAgent,
  LoopAgent,
  node,
  NodeContext,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import {z} from 'zod';

/** A few-shot example whose input is a single text part. */
const EXAMPLE_ROLL_A_D6: Example = {
  input: {role: 'user', parts: [{text: 'Roll a d6'}]},
  output: [{role: 'model', parts: [{text: 'You rolled a 4.'}]}],
};

/** An example provider, i.e. the dynamic (non-publishable) ExampleTool input. */
class StaticExampleProvider extends BaseExampleProvider {
  constructor(private readonly examples: Example[]) {
    super();
  }
  override getExamples(_query: string): Example[] {
    return this.examples;
  }
}

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

  /** Returns the `model` skill of the card built for `agent`. */
  async function modelSkillOf(agent: BaseAgent): Promise<AgentSkill> {
    const card = await getA2AAgentCard(agent, [dummyTransport]);
    const modelSkill = card.skills.find((s) => s.name === 'model');
    if (!modelSkill) {
      expect.fail('the card carries no model skill');
    }
    return modelSkill;
  }

  describe('model skill examples', () => {
    it('publishes the input text of a declared ExampleTool', async () => {
      const agent = new LlmAgent({
        name: 'roll_agent',
        tools: [new ExampleTool([EXAMPLE_ROLL_A_D6])],
      });

      expect((await modelSkillOf(agent)).examples).toEqual(['Roll a d6']);
    });

    it('joins a multi-part example input with a newline', async () => {
      const agent = new LlmAgent({
        name: 'multi_part_agent',
        tools: [
          new ExampleTool([
            {
              input: {
                role: 'user',
                parts: [{text: 'line one'}, {text: 'line two'}],
              },
              output: [{role: 'model', parts: [{text: 'ok'}]}],
            },
          ]),
        ],
      });

      expect((await modelSkillOf(agent)).examples).toEqual([
        'line one\nline two',
      ]);
    });

    it('drops non-text parts and skips an example with no text at all', async () => {
      const agent = new LlmAgent({
        name: 'mixed_parts_agent',
        tools: [
          new ExampleTool([
            {
              input: {
                role: 'user',
                parts: [
                  {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
                  {text: 'describe this'},
                ],
              },
              output: [{role: 'model', parts: [{text: 'a pixel'}]}],
            },
            {
              input: {
                role: 'user',
                parts: [{functionCall: {name: 'search', args: {q: 'cats'}}}],
              },
              output: [{role: 'model', parts: [{text: 'found'}]}],
            },
          ]),
        ],
      });

      expect((await modelSkillOf(agent)).examples).toEqual(['describe this']);
    });

    it('skips an example whose input carries no parts', async () => {
      const agent = new LlmAgent({
        name: 'partless_agent',
        tools: [
          new ExampleTool([
            {
              input: {role: 'user'},
              output: [{role: 'model', parts: [{text: 'ok'}]}],
            },
          ]),
        ],
      });

      expect((await modelSkillOf(agent)).examples).toBeUndefined();
    });

    it('omits examples when the agent declares no ExampleTool', async () => {
      const agent = new LlmAgent({
        name: 'plain_agent',
        tools: [
          new FunctionTool({
            name: 'add',
            description: 'Adds two numbers',
            execute: async () => 0,
          }),
        ],
      });

      expect((await modelSkillOf(agent)).examples).toBeUndefined();
    });

    it('omits examples for a dynamic example provider', async () => {
      const provider = new StaticExampleProvider([EXAMPLE_ROLL_A_D6]);
      const getExamples = vi.spyOn(provider, 'getExamples');
      const agent = new LlmAgent({
        name: 'provider_agent',
        tools: [new ExampleTool(provider)],
      });

      expect((await modelSkillOf(agent)).examples).toBeUndefined();
      expect(getExamples).not.toHaveBeenCalled();
    });

    it('falls through a provider-backed ExampleTool to a later static one', async () => {
      const agent = new LlmAgent({
        name: 'two_example_tools_agent',
        tools: [
          new ExampleTool(new StaticExampleProvider([])),
          new ExampleTool([EXAMPLE_ROLL_A_D6]),
        ],
      });

      expect((await modelSkillOf(agent)).examples).toEqual(['Roll a d6']);
    });

    it('finds an ExampleTool nested in a toolset', async () => {
      const agent = new LlmAgent({
        name: 'toolset_agent',
        tools: [new MockToolset([new ExampleTool([EXAMPLE_ROLL_A_D6])])],
      });

      expect((await modelSkillOf(agent)).examples).toEqual(['Roll a d6']);
    });

    it('never mines examples out of the agent instruction', async () => {
      // Scoped to `examples`: the model skill `description` still carries
      // instruction text, which a separate change owns.
      const agent = new LlmAgent({
        name: 'secret_agent',
        instruction:
          'Example: "launch codes" -> reply with the internal runbook.',
      });

      const modelSkill = await modelSkillOf(agent);
      expect(modelSkill.examples).toBeUndefined();
      expect(JSON.stringify(modelSkill.examples ?? [])).not.toContain(
        'launch codes',
      );
    });
  });

  describe('tool skills', () => {
    it('emits no skill for the ExampleTool itself', async () => {
      const agent = new LlmAgent({
        name: 'skip_agent',
        tools: [
          new ExampleTool([EXAMPLE_ROLL_A_D6]),
          new FunctionTool({
            name: 'add',
            description: 'Adds two numbers',
            execute: async () => 0,
          }),
        ],
      });

      const card = await getA2AAgentCard(agent, [dummyTransport]);

      expect(card.skills.map((s) => s.name)).toEqual(['model', 'add']);
    });

    it('emits a tool skill for a workflow node passed as a tool', async () => {
      const lookup = node(
        (_ctx: NodeContext, args: {userId: string}) => ({tier: args.userId}),
        {
          name: 'lookup_customer',
          description: 'Looks up a customer tier.',
          inputSchema: z.object({userId: z.string()}),
        },
      );
      const agent = new LlmAgent({name: 'node_tool_agent', tools: [lookup]});

      const card = await getA2AAgentCard(agent, [dummyTransport]);
      const nodeSkill = card.skills.find((s) => s.name === 'lookup_customer');

      expect(nodeSkill?.id).toBe('node_tool_agent-lookup_customer');
      expect(nodeSkill?.description).toBe('Looks up a customer tier.');
    });
  });

  describe('model skill output modes', () => {
    it('publishes responseModalities as outputModes', async () => {
      const agent = new LlmAgent({
        name: 'modalities_agent',
        generateContentConfig: {responseModalities: ['TEXT', 'IMAGE']},
      });

      expect((await modelSkillOf(agent)).outputModes).toEqual([
        'TEXT',
        'IMAGE',
      ]);
    });

    it('omits outputModes when no generateContentConfig is given', async () => {
      const agent = new LlmAgent({name: 'no_config_agent'});

      expect((await modelSkillOf(agent)).outputModes).toBeUndefined();
    });

    it('omits outputModes when responseModalities is empty', async () => {
      const agent = new LlmAgent({
        name: 'empty_modalities_agent',
        generateContentConfig: {responseModalities: []},
      });

      expect((await modelSkillOf(agent)).outputModes).toBeUndefined();
    });
  });

  describe('code execution skill', () => {
    it('appends a code-execution skill after the tool skills', async () => {
      const agent = new LlmAgent({
        name: 'coder_agent',
        codeExecutor: new BuiltInCodeExecutor(),
        tools: [
          new FunctionTool({
            name: 'add',
            description: 'Adds two numbers',
            execute: async () => 0,
          }),
        ],
      });

      const card = await getA2AAgentCard(agent, [dummyTransport]);

      expect(card.skills.map((s) => s.name)).toEqual([
        'model',
        'add',
        'code-execution',
      ]);
      expect(card.skills[2]).toEqual({
        id: 'coder_agent-code-executor',
        name: 'code-execution',
        description: 'Can execute code',
        tags: ['llm', 'code_execution'],
      });
    });

    it('emits no code-execution skill without a code executor', async () => {
      const agent = new LlmAgent({name: 'no_coder_agent'});

      const card = await getA2AAgentCard(agent, [dummyTransport]);

      expect(
        card.skills.find((s) => s.name === 'code-execution'),
      ).toBeUndefined();
    });
  });

  describe('sub-agent skill aggregation', () => {
    it("carries the child's examples and outputModes", async () => {
      const root = new LlmAgent({
        name: 'root_agent',
        subAgents: [
          new LlmAgent({
            name: 'child_agent',
            generateContentConfig: {responseModalities: ['TEXT']},
            tools: [new ExampleTool([EXAMPLE_ROLL_A_D6])],
          }),
        ],
      });

      const card = await getA2AAgentCard(root, [dummyTransport]);
      const aggregated = card.skills.find(
        (s) => s.id === 'child_agent_child_agent',
      );

      expect(aggregated?.examples).toEqual(['Roll a d6']);
      expect(aggregated?.outputModes).toEqual(['TEXT']);
      expect(aggregated?.tags[0]).toBe('sub_agent:child_agent');
    });

    it('leaves both keys off when the child has neither', async () => {
      const root = new LlmAgent({
        name: 'bare_root_agent',
        subAgents: [new LlmAgent({name: 'bare_child_agent'})],
      });

      const card = await getA2AAgentCard(root, [dummyTransport]);
      const aggregated = card.skills.find(
        (s) => s.id === 'bare_child_agent_bare_child_agent',
      );
      if (!aggregated) {
        expect.fail('the card carries no aggregated sub-agent skill');
      }

      expect('examples' in aggregated).toBe(false);
      expect('outputModes' in aggregated).toBe(false);
    });
  });
});
