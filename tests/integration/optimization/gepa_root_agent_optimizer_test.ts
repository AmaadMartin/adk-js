/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives a whole GEPA optimization over an agent and its skill: an engine that
 * evaluates, reflects through the real model plumbing, and evaluates again.
 * Nothing inside ADK is stubbed, and it needs no credentials and no network.
 *
 * The sampler, the skill and the workflow come from
 * `samples/optimization/gepa_root_agent_optimizer/agent.ts`, so those fixtures
 * have one copy and this suite executes the sample.
 */

import {
  AGENT_PROMPT_NAME,
  BaseLlm,
  GEPARootAgentOptimizer,
  isSkillToolset,
  LlmAgent,
  LLMRegistry,
  requireStaticInstruction,
  skillComponentKey,
  SkillToolset,
  type BaseLlmConnection,
  type GepaEngine,
  type GepaOptimizeParams,
  type GepaRunResult,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  CANDIDATE_INSTRUCTION,
  CANDIDATE_SKILL_INSTRUCTIONS,
  PhraseCoverageSampler,
  refundSkill,
  rootAgent,
  SKILL_NAME,
  startingAgent,
} from '../../../samples/optimization/gepa_root_agent_optimizer/agent.js';
import {
  allEvents,
  finalOutput,
  runSample,
} from '../workflows/_harness/sample_harness.js';

const REFLECTION_MODEL = 'integration-gepa-root-reflector';
const SKILL_KEY = skillComponentKey(SKILL_NAME);
const STARTING_INSTRUCTION = requireStaticInstruction(startingAgent);

/**
 * A model that answers each reflection with the rewrite that component wants.
 *
 * It reads the prompt to decide, which is what proves the adapter renders the
 * skill template for a skill component and the agent template for the prompt.
 */
class ScriptedReflectionLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /integration-gepa-root-.*/,
  ];

  /** The prompt text of every reflection request, across the suite. */
  static readonly prompts: string[] = [];

  /** When true, the model answers without a fenced block. */
  static omitFencedBlock = false;

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const prompt = llmRequest.contents[0].parts?.[0].text ?? '';
    ScriptedReflectionLlm.prompts.push(prompt);

    const rewrite = prompt.includes(`a skill named \`${SKILL_NAME}\``)
      ? CANDIDATE_SKILL_INSTRUCTIONS
      : CANDIDATE_INSTRUCTION;
    const reply = ScriptedReflectionLlm.omitFencedBlock
      ? rewrite
      : `\`\`\`\n${rewrite}\n\`\`\``;

    yield {
      content: {
        role: 'model',
        parts: [
          {text: 'Deciding what to change. ', thought: true},
          {text: reply},
        ],
      },
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return expect.unreachable('ScriptedReflectionLlm has no live connection.');
  }
}

/** One round of evaluate, reflect and re-evaluate over every component. */
class ReflectingEngine implements GepaEngine {
  /** The reflective dataset the adapter produced. */
  reflectiveDataset?: Record<string, Array<Record<string, unknown>>>;

  async optimize(params: GepaOptimizeParams): Promise<GepaRunResult> {
    const {adapter, seedCandidate} = params;
    if (!adapter.proposeNewTexts) {
      return expect.unreachable('The adapter must propose new texts.');
    }

    const components = Object.keys(seedCandidate);
    const evalBatch = await adapter.evaluate(
      params.trainset,
      seedCandidate,
      true,
    );
    this.reflectiveDataset = adapter.makeReflectiveDataset(
      seedCandidate,
      evalBatch,
      components,
    );
    const proposed = await adapter.proposeNewTexts(
      seedCandidate,
      this.reflectiveDataset,
      components,
    );

    const candidates = [seedCandidate, {...seedCandidate, ...proposed}];
    const valAggregateScores: number[] = [];
    for (const candidate of candidates) {
      const {scores} = await adapter.evaluate(params.valset, candidate, false);
      valAggregateScores.push(scores[0]);
    }

    return {
      candidates,
      valAggregateScores,
      toDict: () => ({rounds: 1, tried: candidates.length}),
    };
  }
}

/** Returns a fresh copy of the sample's agent, so no test shares state. */
function createInitialAgent(): LlmAgent {
  return new LlmAgent({
    name: 'support_agent',
    instruction: STARTING_INSTRUCTION,
    tools: [new SkillToolset([refundSkill])],
  });
}

/** Reports the instructions of the one skill an agent exposes. */
function skillInstructions(agent: LlmAgent): string {
  const [toolset] = agent.tools.filter(isSkillToolset);
  return toolset.skills[SKILL_NAME].instructions;
}

describe('GEPARootAgentOptimizer end to end', () => {
  beforeAll(() => {
    LLMRegistry.register(ScriptedReflectionLlm);
  });

  beforeEach(() => {
    ScriptedReflectionLlm.omitFencedBlock = false;
    ScriptedReflectionLlm.prompts.length = 0;
  });

  it('rewrites the instruction and the skill, and scores both candidates', async () => {
    const engine = new ReflectingEngine();
    const initialAgent = createInitialAgent();

    const result = await new GEPARootAgentOptimizer({
      engine,
      optimizerModel: REFLECTION_MODEL,
      maxMetricCalls: 12,
      reflectionMinibatchSize: 2,
    }).optimize({initialAgent, sampler: new PhraseCoverageSampler()});

    expect(
      result.optimizedAgents.map(({optimizedAgent}) => [
        requireStaticInstruction(optimizedAgent),
        skillInstructions(optimizedAgent),
      ]),
    ).toEqual([
      [STARTING_INSTRUCTION, refundSkill.instructions],
      [CANDIDATE_INSTRUCTION, CANDIDATE_SKILL_INSTRUCTIONS],
    ]);
    expect(
      result.optimizedAgents.map(({overallScore}) => overallScore),
    ).toEqual([0.5, 1]);
    expect(result.gepaResult).toEqual({rounds: 1, tried: 2});

    // The starting agent and its skill are untouched.
    expect(initialAgent.instruction).toBe(STARTING_INSTRUCTION);
    expect(skillInstructions(initialAgent)).toBe(refundSkill.instructions);
    expect(refundSkill.instructions).toBe(
      'Refund an order when the user asks.',
    );
  });

  it('reflects on each component with its own template', async () => {
    const engine = new ReflectingEngine();

    await new GEPARootAgentOptimizer({
      engine,
      optimizerModel: REFLECTION_MODEL,
    }).optimize({
      initialAgent: createInitialAgent(),
      sampler: new PhraseCoverageSampler(),
    });

    // The skill comes first in the seed candidate, so it reflects first.
    expect(ScriptedReflectionLlm.prompts).toHaveLength(2);
    expect(ScriptedReflectionLlm.prompts[0]).toContain(
      `a skill named \`${SKILL_NAME}\``,
    );
    expect(ScriptedReflectionLlm.prompts[1]).toContain(
      'a new version of the agent core instructions',
    );
    // The model's thought part never reaches the rewritten instruction.
    expect(ScriptedReflectionLlm.prompts[0]).not.toContain('Deciding what');

    // Only the example whose eval data names the skill reaches its dataset.
    expect(engine.reflectiveDataset?.[SKILL_KEY]).toHaveLength(1);
    expect(engine.reflectiveDataset?.[AGENT_PROMPT_NAME]).toHaveLength(3);
  });

  it('refuses a reflection reply that carries no fenced block', async () => {
    ScriptedReflectionLlm.omitFencedBlock = true;

    await expect(
      new GEPARootAgentOptimizer({
        engine: new ReflectingEngine(),
        optimizerModel: REFLECTION_MODEL,
      }).optimize({
        initialAgent: createInitialAgent(),
        sampler: new PhraseCoverageSampler(),
      }),
    ).rejects.toThrow(/no fenced block for component skill_instructions:/);
  });

  it('runs the sample workflow without a model', async () => {
    const perTurn = await runSample({
      name: 'optimization/gepa_root_agent_optimizer',
      rootAgent,
      turns: ['optimize the agent'],
      offline: true,
    });

    expect(finalOutput(allEvents(perTurn))).toBe(
      'validation score 0.5: agent: Help the user with their order. | ' +
        'skill refund_policy: Refund an order when the user asks.\n' +
        'validation score 1: agent: Help the user with their order. Confirm ' +
        'the order id before you act. | skill refund_policy: Refund an order ' +
        'only inside the refund window, and say which window applied.',
    );
  });
});
