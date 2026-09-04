/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/evaluation/simulation/test_per_turn_user_simulation_quality_prompts.py`
 * from google/adk-python at commit 30493bae56f6. Each `it` keeps the name of
 * the Python test it ports.
 *
 * Two Python tests read the module's private template constants, and two swap
 * them with `mocker.patch`. Neither is available here: the constants are not
 * exported, and an ES module binding cannot be reassigned from outside. Both
 * pairs are ported as assertions on the rendered prompt, which is the only
 * thing the templates are for.
 */

import {
  getPerTurnUserSimulatorQualityPrompt,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A line the no-persona template carries and the persona template does not. */
const DEFAULT_TEMPLATE_MARKER =
  'To determine this, we provide specific Evaluation Criteria that must be' +
  ' satisfied by the Generated User Response.';

/** A heading only the persona template carries. */
const PERSONA_TEMPLATE_MARKER = '# Definition of Persona';

const TEST_PERSONA: UserPersona = {
  id: 'test_persona',
  description: 'Test persona description.',
  behaviors: [
    {
      name: 'test_behavior',
      description: 'Test behavior description.',
      behaviorInstructions: ['instruction1'],
      violationRubrics: ['violation1'],
    },
  ],
};

function renderPrompt(userPersona?: UserPersona): string {
  return getPerTurnUserSimulatorQualityPrompt({
    conversationPlan: 'plan',
    conversationHistory: 'history',
    generatedUserResponse: 'response',
    stopSignal: 'stop',
    userPersona,
  });
}

describe('GetLatestTurnUserSimulatorQualityPrompt', () => {
  it('test_get_get_latest_turn_user_simulator_quality_prompt_template_default', () => {
    const prompt = renderPrompt();

    expect(prompt).toContain(DEFAULT_TEMPLATE_MARKER);
    expect(prompt).not.toContain(PERSONA_TEMPLATE_MARKER);
  });

  it('test_get_latest_turn_user_simulator_quality_prompt_template_with_persona', () => {
    const prompt = renderPrompt(TEST_PERSONA);

    expect(prompt).toContain(PERSONA_TEMPLATE_MARKER);
    expect(prompt).not.toContain(DEFAULT_TEMPLATE_MARKER);
  });
});

describe('GetPerTurnUserSimulatorQualityPrompt', () => {
  it('test_get_per_turn_user_simulator_quality_prompt_default', () => {
    const prompt = renderPrompt();

    expect(prompt).toContain('# Conversation Plan\nplan\n');
    expect(prompt).toContain('# Conversation History\nhistory\n');
    expect(prompt).toContain('# Generated User Response\nresponse');
    expect(prompt).toContain(
      'The Conversation History is finished only when the User Simulator' +
        ' outputs `stop` in its response.',
    );
    expect(prompt).not.toContain('{{');
  });

  it('test_get_per_turn_user_simulator_quality_prompt_with_persona', () => {
    const prompt = renderPrompt(TEST_PERSONA);

    expect(prompt).toContain(
      '## Criteria: test_behavior\n' +
        'Test behavior description.\n' +
        '\n' +
        'Mark as FAIL if any of the following Violations occur:\n' +
        '  * violation1\n',
    );
    expect(prompt).toContain(
      '# Persona Description\nTest persona description.',
    );
    expect(prompt).toContain('# Conversation Plan\nplan\n');
    expect(prompt).toContain('# Conversation History\nhistory\n');
    expect(prompt).toContain('# Generated User Response\nresponse');
    expect(prompt).not.toContain('{{');
  });

  it('test_get_per_turn_user_simulator_quality_prompt_renders_persona_templates_in_sandbox', () => {
    const prompt = renderPrompt({
      id: 'test_persona',
      description: 'Test persona description.',
      behaviors: [
        {
          name: 'criteria {{ stop_signal }}',
          description: 'Test behavior {{ stop_signal }}.',
          behaviorInstructions: ['instruction1'],
          violationRubrics: ['violation {{ stop_signal }}'],
        },
      ],
    });

    expect(prompt).toContain('## Criteria: criteria stop');
    expect(prompt).toContain('Test behavior stop.');
    expect(prompt).toContain('  * violation stop');
  });

  it('test_get_per_turn_user_simulator_quality_prompt_blocks_unsafe_persona_templates', () => {
    // adk-python raises a Jinja `SecurityError` here. nunjucks has no sandbox,
    // so a persona field is substituted rather than compiled, and an
    // expression that is not a plain dotted path renders empty.
    const prompt = renderPrompt({
      id: 'test_persona',
      description: 'Test persona description.',
      behaviors: [
        {
          name: "{{ ''.constructor.constructor('return 1')() }}",
          description: 'Test behavior description.',
          behaviorInstructions: ['instruction1'],
          violationRubrics: ['violation1'],
        },
      ],
    });

    expect(prompt).toContain('## Criteria: \n');
    expect(prompt).not.toContain('constructor');
  });
});
