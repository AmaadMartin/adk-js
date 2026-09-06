/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {getPerTurnUserSimulatorQualityPrompt} from '../../../src/evaluation/simulation/per_turn_user_simulator_quality_prompts.js';
import type {
  UserBehavior,
  UserPersona,
} from '../../../src/evaluation/simulation/user_simulator_personas.js';

function personaWith(behavior: Partial<UserBehavior> = {}): UserPersona {
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

const BASE_OPTIONS = {
  conversationPlan: 'plan',
  conversationHistory: 'history',
  generatedUserResponse: 'response',
  stopSignal: '</finished>',
};

function behavior(overrides: Partial<UserBehavior> = {}): UserBehavior {
  return {
    name: 'polite',
    description: 'Says please.',
    behaviorInstructions: ['be polite'],
    violationRubrics: ['was rude'],
    ...overrides,
  };
}

function persona(behaviors: UserBehavior[]): UserPersona {
  return {id: 'p', description: 'A polite traveller.', behaviors};
}

/**
 * Ported from
 * `tests/unittests/evaluation/simulation/test_per_turn_user_simulation_quality_prompts.py`
 * of `google/adk-python`, at commit 852b575e9d12. Each `it` keeps the name of
 * the reference test it came from.
 */
describe('ported from adk-python', () => {
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
});

/**
 * Cases the adk-python reference tests do not cover: what the renderer does
 * with an expression it does not recognize, and with more than one behavior.
 */
describe('adk-js specific', () => {
  describe('getPerTurnUserSimulatorQualityPrompt rendering', () => {
    it('renders one criteria section per behavior, in order', () => {
      const prompt = getPerTurnUserSimulatorQualityPrompt({
        ...BASE_OPTIONS,
        userPersona: persona([
          behavior({name: 'first', violationRubrics: ['a', 'b']}),
          behavior({name: 'second'}),
        ]),
      });

      expect(prompt).toContain(
        '\n## Criteria: first\nSays please.\n' +
          '\nMark as FAIL if any of the following Violations occur:\n' +
          '  * a\n  * b\n' +
          '\n## Criteria: second\n',
      );
      expect(prompt.indexOf('## Criteria: first')).toBeLessThan(
        prompt.indexOf('## Criteria: second'),
      );
    });

    it('renders a persona with no behaviors without a criteria section', () => {
      const prompt = getPerTurnUserSimulatorQualityPrompt({
        ...BASE_OPTIONS,
        userPersona: persona([]),
      });

      expect(prompt).not.toContain('## Criteria:');
      expect(prompt).toContain(
        'in which case it is marked as FAIL.\n\n# Output Format\n',
      );
    });

    it('renders an expression that walks the prototype as nothing', () => {
      const prompt = getPerTurnUserSimulatorQualityPrompt({
        ...BASE_OPTIONS,
        userPersona: persona([
          behavior({
            name: '{{ constructor.constructor }}',
            description: '{{ persona.behaviors }}',
            violationRubrics: ['{{ __proto__ }}', '{{ toString }}'],
          }),
        ]),
      });

      expect(prompt).toContain('## Criteria: \n\n');
      expect(prompt).toContain('  * \n  * \n');
      expect(prompt).not.toContain('function');
      expect(prompt).not.toContain('[object');
    });

    it('renders a call expression as nothing', () => {
      const prompt = getPerTurnUserSimulatorQualityPrompt({
        ...BASE_OPTIONS,
        userPersona: persona([
          behavior({name: '{{ stop_signal.toUpperCase() }}'}),
        ]),
      });

      expect(prompt).toContain('## Criteria: \n');
      expect(prompt).not.toContain('FINISHED');
    });

    it('names the persona description, but does not render it as a template', () => {
      const prompt = getPerTurnUserSimulatorQualityPrompt({
        ...BASE_OPTIONS,
        userPersona: {
          id: 'p',
          description: 'Tells you to say {{ stop_signal }}.',
          behaviors: [behavior({name: '{{ persona.description }}'})],
        },
      });

      // The outer template inserts the description verbatim.
      expect(prompt).toContain(
        '# Persona Description\nTells you to say {{ stop_signal }}.\n',
      );
      // A persona field that names it gets the same verbatim text, rendered
      // once rather than recursively.
      expect(prompt).toContain(
        '## Criteria: Tells you to say {{ stop_signal }}.\n',
      );
    });

    it('cannot name the criteria section it is part of', () => {
      const prompt = getPerTurnUserSimulatorQualityPrompt({
        ...BASE_OPTIONS,
        userPersona: persona([behavior({name: '{{ persona_criteria }}'})]),
      });

      expect(prompt).toContain('## Criteria: \n');
    });

    it('leaves a conversation value that looks like a placeholder alone', () => {
      const prompt = getPerTurnUserSimulatorQualityPrompt({
        ...BASE_OPTIONS,
        generatedUserResponse: '{{ conversation_plan }}',
      });

      expect(
        prompt.endsWith('# Generated User Response\n{{ conversation_plan }}'),
      ).toBe(true);
    });
  });
});
