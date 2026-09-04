/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from
 * `tests/unittests/evaluation/simulation/test_per_turn_user_simulation_quality_prompts.py`
 * of `google/adk-python`, at commit 852b575e9d12. Each `it` keeps the name of
 * the reference test it came from.
 */

import {
  getPerTurnUserSimulatorQualityPrompt,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function personaWith(
  behavior: Partial<UserPersona['behaviors'][number]> = {},
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
        ...behavior,
      },
    ],
  };
}

describe('getPerTurnUserSimulatorQualityPrompt', () => {
  // Adapted: the template picker is module-private in TypeScript, so the
  // choice is asserted through the rendered prompt.
  it('test_get_get_latest_turn_user_simulator_quality_prompt_template_default', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
    });

    expect(prompt).not.toContain('# Definition of Persona');
    expect(prompt).not.toContain('# Persona Description');
    expect(prompt).toContain('** CONVERSATION_PLAN_FOLLOWED **');
  });

  // Adapted for the same reason as the test above.
  it('test_get_latest_turn_user_simulator_quality_prompt_template_with_persona', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
      userPersona: personaWith(),
    });

    expect(prompt).toContain('# Definition of Persona');
    expect(prompt).toContain('# Persona Description');
    expect(prompt).not.toContain('** CONVERSATION_PLAN_FOLLOWED **');
  });

  // Adapted: the reference patches a module constant to a mock template, which
  // ESM does not allow, so the substituted values are asserted against the
  // real template.
  it('test_get_per_turn_user_simulator_quality_prompt_default', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
    });

    expect(prompt).toContain('# Conversation Plan\nplan\n');
    expect(prompt).toContain('# Conversation History\nhistory\n');
    expect(prompt.endsWith('# Generated User Response\nresponse')).toBe(true);
    expect(prompt).toContain('the User Simulator outputs `stop` in its');
    expect(prompt).not.toContain('{{');
  });

  // Adapted for the same reason as the test above.
  it('test_get_per_turn_user_simulator_quality_prompt_with_persona', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
      userPersona: personaWith(),
    });

    expect(prompt).toContain(
      'in which case it is marked as FAIL.\n' +
        '\n' +
        '## Criteria: test_behavior\n' +
        'Test behavior description.\n' +
        '\n' +
        'Mark as FAIL if any of the following Violations occur:\n' +
        '  * violation1\n' +
        '\n' +
        '# Output Format\n',
    );
    expect(prompt).toContain(
      '# Persona Description\nTest persona description.\n',
    );
    expect(prompt).toContain('# Conversation Plan\nplan\n');
    expect(prompt).toContain('# Conversation History\nhistory\n');
    expect(prompt.endsWith('# Generated User Response\nresponse')).toBe(true);
    expect(prompt).toContain('the User Simulator outputs `stop` in its');
    expect(prompt).not.toContain('{{');
  });

  it('test_get_per_turn_user_simulator_quality_prompt_renders_persona_templates_in_sandbox', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
      userPersona: personaWith({
        name: 'criteria {{ stop_signal }}',
        description: 'Test behavior {{ stop_signal }}.',
        violationRubrics: ['violation {{ stop_signal }}'],
      }),
    });

    expect(prompt).toContain('## Criteria: criteria stop');
    expect(prompt).toContain('Test behavior stop.');
    expect(prompt).toContain('  * violation stop');
  });

  // Ported, asserting the adk-js behaviour. jinja2's `SandboxedEnvironment`
  // raises `SecurityError` for an expression that walks the prototype; this
  // renderer names an allowlist of values, so the expression matches nothing
  // and renders as the empty string.
  it('test_get_per_turn_user_simulator_quality_prompt_blocks_unsafe_persona_templates', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: 'stop',
      userPersona: personaWith({name: "{{ ''.__class__.__mro__ }}"}),
    });

    expect(prompt).toContain('## Criteria: \n');
    expect(prompt).not.toContain('__mro__');
  });
});
