/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_per_turn_user_simulation_quality_prompts.py`.
 * Each `it` name is the reference test name, so a reviewer can grep for it.
 */

import {
  getPerTurnUserSimulatorQualityPrompt,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  LATEST_TURN_USER_SIMULATOR_EVALUATOR_PROMPT_TEMPLATE,
  LATEST_TURN_USER_SIMULATOR_WITH_PERSONA_EVALUATOR_PROMPT_TEMPLATE,
  getLatestTurnUserSimulatorQualityPromptTemplate,
} from '../../../src/evaluation/simulation/per_turn_user_simulator_quality_prompts.js';

function createPersona(
  overrides: Partial<UserPersona['behaviors'][0]> = {},
): UserPersona {
  return {
    id: 'test_persona',
    description: 'Test persona description.',
    behaviors: [
      {
        name: 'test_behavior',
        description: 'Test behavior description.',
        behaviorInstructions: ['instruction1'],
        violationRubrics: ['violation1'],
        ...overrides,
      },
    ],
  };
}

describe('getLatestTurnUserSimulatorQualityPromptTemplate', () => {
  it('test_get_get_latest_turn_user_simulator_quality_prompt_template_default', () => {
    const prompt = getLatestTurnUserSimulatorQualityPromptTemplate(undefined);

    expect(prompt).toBe(LATEST_TURN_USER_SIMULATOR_EVALUATOR_PROMPT_TEMPLATE);
  });

  it('test_get_latest_turn_user_simulator_quality_prompt_template_with_persona', () => {
    const prompt =
      getLatestTurnUserSimulatorQualityPromptTemplate(createPersona());

    expect(prompt).toBe(
      LATEST_TURN_USER_SIMULATOR_WITH_PERSONA_EVALUATOR_PROMPT_TEMPLATE,
    );
  });
});

describe('getPerTurnUserSimulatorQualityPrompt', () => {
  // adk-python patches the module constant with a short template it can
  // compare against in full. A TypeScript module constant is not patchable, so
  // this renders the real default template and asserts every variable landed.
  it('test_get_per_turn_user_simulator_quality_prompt_default', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
      userPersona: undefined,
    });

    expect(prompt).toContain('# Conversation Plan\nplan');
    expect(prompt).toContain('# Conversation History\nhistory');
    expect(prompt).toContain('# Generated User Response\nresponse');
    expect(prompt).toContain(
      'the User Simulator outputs `stop` in its response',
    );
    expect(prompt).not.toContain('# Definition of Persona');
    expect(prompt).not.toContain('{{');
  });

  it('test_get_per_turn_user_simulator_quality_prompt_with_persona', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
      userPersona: createPersona(),
    });

    expect(prompt).toContain('# Definition of Persona');
    expect(prompt).toContain(
      '# Persona Description\nTest persona description.',
    );
    expect(prompt).toContain(
      [
        '## Criteria: test_behavior',
        'Test behavior description.',
        '',
        'Mark as FAIL if any of the following Violations occur:',
        '  * violation1',
      ].join('\n'),
    );
    expect(prompt).toContain('# Conversation Plan\nplan');
    expect(prompt).toContain('# Generated User Response\nresponse');
    expect(prompt).not.toContain('{{');
  });

  it('test_get_per_turn_user_simulator_quality_prompt_renders_persona_templates_in_sandbox', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
      userPersona: createPersona({
        name: 'criteria {{ stop_signal }}',
        description: 'Test behavior {{ stop_signal }}.',
        violationRubrics: ['violation {{ stop_signal }}'],
      }),
    });

    expect(prompt).toContain('## Criteria: criteria stop');
    expect(prompt).toContain('Test behavior stop.');
    expect(prompt).toContain('  * violation stop');
  });

  // Divergence D6: adk-python renders persona fields through a Jinja2
  // `SandboxedEnvironment` and raises `SecurityError` here. The TypeScript
  // renderer compiles nothing, so there is no sandbox to escape: an expression
  // that is not a plain dotted path renders as the empty string.
  it('test_get_per_turn_user_simulator_quality_prompt_blocks_unsafe_persona_templates', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
      userPersona: createPersona({name: "{{ ''.__class__.__mro__ }}"}),
    });

    expect(prompt).toContain('## Criteria: \n');
    expect(prompt).not.toContain('__mro__');
    expect(prompt).not.toContain('class');
  });
});
