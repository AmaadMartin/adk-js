/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AGENT_PROMPT_NAME,
  GEPARootAgentOptimizer,
  GEPARootAgentPromptOptimizer,
  skillComponentKey,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  createAgent,
  createSkill,
  INITIAL_INSTRUCTION,
} from './gepa_root_agent_test_utils.js';
import {
  FakeGepaEngine,
  onlyOptimizeCall,
  RecordingSampler,
  runResult,
} from './gepa_test_utils.js';

/**
 * Both optimizers write the root agent's instruction into the same GEPA
 * component, so a candidate one of them produced is readable by the other and
 * by a checkpoint either of them wrote. That only holds while the two read one
 * shared constant.
 */

function createSampler(): RecordingSampler {
  return new RecordingSampler({
    trainIds: ['train1'],
    validationIds: ['val1'],
    result: {scores: {train1: 0.5, val1: 0.5}},
  });
}

function createEngine(): FakeGepaEngine {
  return new FakeGepaEngine(
    runResult([{[AGENT_PROMPT_NAME]: 'Rewritten'}], [1]),
  );
}

describe('the agent prompt component key', () => {
  it('is the key GEPARootAgentPromptOptimizer seeds the root instruction under', async () => {
    const engine = createEngine();

    await new GEPARootAgentPromptOptimizer({engine}).optimize({
      initialAgent: createAgent(),
      sampler: createSampler(),
    });

    expect(onlyOptimizeCall(engine).seedCandidate).toEqual({
      [AGENT_PROMPT_NAME]: INITIAL_INSTRUCTION,
    });
  });

  it('is the key GEPARootAgentOptimizer seeds the root instruction under', async () => {
    const engine = createEngine();
    const toolset = new SkillToolset([createSkill('my_skill', 'Skill text')]);

    await new GEPARootAgentOptimizer({engine}).optimize({
      initialAgent: createAgent([toolset]),
      sampler: createSampler(),
    });

    expect(onlyOptimizeCall(engine).seedCandidate).toEqual({
      [skillComponentKey('my_skill')]: 'Skill text',
      [AGENT_PROMPT_NAME]: INITIAL_INSTRUCTION,
    });
  });

  it('lets one optimizer rebuild an agent from the other candidate', async () => {
    // The rewrite must differ from the initial instruction: a candidate keyed
    // under an unknown component falls back to the initial instruction, which
    // would hide the mismatch.
    const rewritten = 'Rewritten by the prompt optimizer';
    const promptEngine = new FakeGepaEngine(
      runResult([{[AGENT_PROMPT_NAME]: rewritten}], [1]),
    );
    const promptResult = await new GEPARootAgentPromptOptimizer({
      engine: promptEngine,
    }).optimize({initialAgent: createAgent(), sampler: createSampler()});
    expect(promptResult.optimizedAgents[0].optimizedAgent.instruction).toBe(
      rewritten,
    );

    const rootEngine = new FakeGepaEngine(
      runResult([{[AGENT_PROMPT_NAME]: rewritten}], [1]),
    );
    const rootResult = await new GEPARootAgentOptimizer({
      engine: rootEngine,
    }).optimize({initialAgent: createAgent(), sampler: createSampler()});

    expect(rootResult.optimizedAgents[0].optimizedAgent.instruction).toBe(
      rewritten,
    );
  });
});
