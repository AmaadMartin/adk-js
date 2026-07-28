/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  GEPARootAgentOptimizer,
  GEPARootAgentOptimizerConfig,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  Sampler,
  Skill,
  SkillToolset,
  UnstructuredSamplingResult,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';

const ORIGINAL_CORE = 'You are a helpful assistant.';
const ORIGINAL_SKILL = 'Original skill instructions.';
const IMPROVED_TEXT = 'Improved instructions produced by reflection.';
const FAKE_LLM_OUTPUT = `Here is my improved proposal.\n\`\`\`\n${IMPROVED_TEXT}\n\`\`\``;
const FAKE_MODEL = 'gepa-e2e-fake-optimizer-model';

/**
 * A hermetic, in-memory reflection model. It always proposes {@link
 * IMPROVED_TEXT} inside a fenced block, so the whole optimizer pipeline (engine,
 * adapter, per-component proposal rendering/extraction, candidate rebuild) runs
 * for real with no network access or credentials.
 */
class FakeReflectionLlm extends BaseLlm {
  static callCount = 0;
  static override readonly supportedModels: Array<string | RegExp> = [
    FAKE_MODEL,
  ];

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    FakeReflectionLlm.callCount++;
    yield {content: {role: 'model', parts: [{text: FAKE_LLM_OUTPUT}]}};
  }

  override connect(): Promise<never> {
    throw new Error('FakeReflectionLlm does not support live connections.');
  }
}

/**
 * A deterministic, in-memory sampler. It scores a candidate agent higher only
 * when its core instruction has been replaced with the improved text, so the
 * GEPA search keeps the reflected candidate.
 */
class InMemorySampler extends Sampler<UnstructuredSamplingResult> {
  override getTrainExampleIds(): string[] {
    return ['ex1', 'ex2'];
  }

  override getValidationExampleIds(): string[] {
    return ['v1', 'v2'];
  }

  override async sampleAndScore(
    candidate: LlmAgent,
    exampleSet: 'train' | 'validation' = 'validation',
    batch?: string[],
    captureFullEvalData = false,
  ): Promise<UnstructuredSamplingResult> {
    const ids =
      batch ??
      (exampleSet === 'train'
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    const improved = candidate.instruction === IMPROVED_TEXT;
    const scores: Record<string, number> = {};
    const data: Record<string, Record<string, unknown>> = {};
    for (const id of ids) {
      scores[id] = improved ? 0.9 : 0.1;
      if (captureFullEvalData) {
        data[id] = {
          instruction: candidate.instruction,
          note: 'this task exercised demo_skill',
        };
      }
    }
    return {scores, data};
  }
}

function skillToolsetOf(agent: LlmAgent): SkillToolset {
  return agent.tools[0] as unknown as SkillToolset;
}

describe('GEPARootAgentOptimizer (end-to-end, real engine)', () => {
  beforeAll(() => {
    LLMRegistry.register(FakeReflectionLlm);
  });

  it('optimizes the core prompt and skill instructions without mutating the original', async () => {
    FakeReflectionLlm.callCount = 0;

    const demoSkill: Skill = {
      frontmatter: {name: 'demo_skill', description: 'A demo skill.'},
      instructions: ORIGINAL_SKILL,
    };
    const agent = new LlmAgent({
      name: 'root',
      model: FAKE_MODEL,
      instruction: ORIGINAL_CORE,
      tools: [new SkillToolset([demoSkill])],
    });
    const originalToolset = agent.tools[0];

    const optimizer = new GEPARootAgentOptimizer(
      new GEPARootAgentOptimizerConfig({
        optimizerModel: FAKE_MODEL,
        maxMetricCalls: 20,
        reflectionMinibatchSize: 2,
      }),
    );

    const result = await optimizer.optimize(agent, new InMemorySampler());

    // The reflection LM was actually invoked (proposeNewTexts ran for real).
    expect(FakeReflectionLlm.callCount).toBeGreaterThan(0);

    // The original agent and its toolset are untouched.
    expect(agent.instruction).toBe(ORIGINAL_CORE);
    expect(agent.tools[0]).toBe(originalToolset);
    expect(skillToolsetOf(agent).skills['demo_skill'].instructions).toBe(
      ORIGINAL_SKILL,
    );

    // The seed candidate lists skill keys before the core prompt key.
    const candidates = result.gepaResult!.candidates as Array<
      Record<string, string>
    >;
    expect(Object.keys(candidates[0])).toEqual([
      'skill_instructions:demo_skill',
      'agent_prompt',
    ]);

    // A rebuilt candidate carries BOTH the improved core instruction and the
    // improved skill instruction, in a fresh, independent SkillToolset.
    const improved = result.optimizedAgents.find(
      (a) => a.optimizedAgent.instruction === IMPROVED_TEXT,
    );
    expect(improved).toBeDefined();
    expect(improved!.overallScore).toBe(0.9);
    const improvedToolset = skillToolsetOf(improved!.optimizedAgent);
    expect(improvedToolset).toBeInstanceOf(SkillToolset);
    expect(improvedToolset).not.toBe(originalToolset);
    expect(improvedToolset.skills['demo_skill'].instructions).toBe(
      IMPROVED_TEXT,
    );
  });
});
