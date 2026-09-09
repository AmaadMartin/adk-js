/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {
  type AgentCardResolver,
  DefaultAgentCardResolver,
} from '@a2a-js/sdk/client';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {buildAgentSkills, resolveAgentCard} from '../../src/a2a/agent_card.js';
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

const {resolveMock} = vi.hoisted(() => ({
  resolveMock: vi.fn<AgentCardResolver['resolve']>(),
}));

/** The resolver's own fallback, `AGENT_CARD_PATH` in `@a2a-js/sdk`. */
const WELL_KNOWN_CARD_PATH = '.well-known/agent-card.json';

/** The URL the resolver fetches, given the arguments it was called with. */
function fetchedCardUrl(): string {
  const [baseUrl, cardUrl] = resolveMock.mock.calls[0];
  return new URL(cardUrl ?? WELL_KNOWN_CARD_PATH, baseUrl).href;
}

vi.mock('@a2a-js/sdk/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@a2a-js/sdk/client')>();
  return {
    ...actual,
    DefaultAgentCardResolver: vi
      .fn()
      .mockImplementation(() => ({resolve: resolveMock})),
  };
});

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

  describe('resolveAgentCard', () => {
    const remoteCard: AgentCard = {
      name: 'remote',
      description: 'a remote agent',
      protocolVersion: '1.0',
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {},
      skills: [],
      url: 'https://example.com',
      version: '1.0',
    };
    let tempDir: string | undefined;

    beforeEach(() => {
      vi.clearAllMocks();
      resolveMock.mockResolvedValue(remoteCard);
    });

    afterEach(async () => {
      if (tempDir) {
        await fs.rm(tempDir, {recursive: true, force: true});
        tempDir = undefined;
      }
    });

    it('fetches the exact path when the card URL has one', async () => {
      const source = 'https://example.com/my-card.json';

      await expect(resolveAgentCard(source)).resolves.toBe(remoteCard);

      expect(fetchedCardUrl()).toBe('https://example.com/my-card.json');
    });

    it('honours a nested card path', async () => {
      const source = 'https://example.com/a2a/agent';

      await resolveAgentCard(source);

      expect(fetchedCardUrl()).toBe('https://example.com/a2a/agent');
    });

    it('keeps the query string on the card path', async () => {
      const source = 'http://localhost:8000/agent.json?v=1';

      await resolveAgentCard(source);

      expect(fetchedCardUrl()).toBe('http://localhost:8000/agent.json?v=1');
    });

    it('keeps a doubled slash on the configured origin', async () => {
      const source = 'https://example.com//evil.com/card.json';

      await resolveAgentCard(source);

      expect(new URL(fetchedCardUrl()).host).toBe('example.com');
      expect(fetchedCardUrl()).toBe('https://example.com//evil.com/card.json');
    });

    it('keeps the userinfo in the card URL', async () => {
      const source = 'https://user:pw@example.com/card.json';

      await resolveAgentCard(source);

      expect(fetchedCardUrl()).toBe('https://user:pw@example.com/card.json');
    });

    it('falls back to the well-known path for a bare origin', async () => {
      const source = 'https://example.com';

      await resolveAgentCard(source);

      expect(resolveMock).toHaveBeenCalledWith(source, undefined);
      expect(fetchedCardUrl()).toBe(
        'https://example.com/.well-known/agent-card.json',
      );
    });

    it('falls back for an origin with a trailing slash', async () => {
      const source = 'https://example.com/';

      await resolveAgentCard(source);

      expect(resolveMock).toHaveBeenCalledWith(source, undefined);
      expect(fetchedCardUrl()).toBe(
        'https://example.com/.well-known/agent-card.json',
      );
    });

    it('falls back for a mount path with a trailing slash', async () => {
      const source = 'https://example.com/a2a/weather_agent/';

      await resolveAgentCard(source);

      expect(resolveMock).toHaveBeenCalledWith(source, undefined);
      expect(fetchedCardUrl()).toBe(
        'https://example.com/a2a/weather_agent/.well-known/agent-card.json',
      );
    });

    it('throws on a malformed card URL', async () => {
      await expect(resolveAgentCard('http://')).rejects.toThrow(TypeError);

      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('reads a file source without contacting the resolver', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-agent-card-'));
      const file = path.join(tempDir, 'card.json');
      await fs.writeFile(file, JSON.stringify(remoteCard), 'utf-8');

      await expect(resolveAgentCard(file)).resolves.toEqual(remoteCard);

      expect(DefaultAgentCardResolver).not.toHaveBeenCalled();
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('reports the file that could not be read', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-agent-card-'));
      const missing = path.join(tempDir, 'absent.json');

      await expect(resolveAgentCard(missing)).rejects.toThrow(
        `Failed to read agent card from file ${missing}: `,
      );
    });

    it('returns an AgentCard object unchanged', async () => {
      await expect(resolveAgentCard(remoteCard)).resolves.toBe(remoteCard);

      expect(DefaultAgentCardResolver).not.toHaveBeenCalled();
    });
  });
});
