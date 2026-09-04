/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/evaluation/simulation/test_llm_backed_user_simulator_prompts.py`
 * from google/adk-python at commit 30493bae56f6. Each `it` keeps the name of
 * the Python test it ports.
 *
 * adk-python patches the two built-in templates with short stand-ins before it
 * asserts a rendering. A module constant cannot be patched here, so a rendering
 * of an arbitrary template is asserted through `customInstructions`, which
 * takes the same path, and the built-in templates are asserted on the parts
 * they must produce.
 */

import {
  getLlmBackedUserSimulatorPrompt,
  getUserSimulatorInstructionsTemplate,
  InputValidationError,
  isValidUserSimulatorTemplate,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const SAMPLE_PERSONA: UserPersona = {
  id: 'test_persona',
  description: 'Test persona description',
  behaviors: [
    {
      name: 'Test behavior',
      description: 'Test behavior description',
      behaviorInstructions: ['instruction 1', 'instruction 2'],
      violationRubrics: ['rubric 1'],
    },
  ],
};

const PERSONA_INSTRUCTIONS = `Persona template

# Persona Description
{{ persona.description }}
{% for b in persona.behaviors %}
## {{ b.name | render_string_filter }}
{{ b.description | render_string_filter }}

Instructions:
{{ b.behavior_instructions_str | render_string_filter }}
{% endfor %}
# Conversation Plan
{{ conversation_plan }}

# Conversation History
{{ conversation_history }}

# Stop signal
{{ stop_signal }}`;

describe('TestGetUserSimulatorInstructionsTemplate', () => {
  it('test_get_user_simulator_instructions_template_default', () => {
    const template = getUserSimulatorInstructionsTemplate();

    expect(template).toContain('# Primary Operating Loop');
    expect(template).toContain('{{ conversation_plan }}');
    expect(template).toContain('{{ conversation_history }}');
    expect(template).toContain('{{ stop_signal }}');
    expect(template).not.toContain('persona');
  });

  it('test_get_user_simulator_instructions_template_with_custom_instructions', () => {
    expect(getUserSimulatorInstructionsTemplate('custom instructions')).toBe(
      'custom instructions',
    );
  });

  it('test_get_user_simulator_instructions_template_with_persona', () => {
    const template = getUserSimulatorInstructionsTemplate(undefined, {
      id: 'test_persona',
      description: 'Test persona',
      behaviors: [],
    });

    expect(template).toContain('{% for b in persona.behaviors %}');
    expect(template).toContain('{{ persona.description }}');
    expect(template).toContain('render_string_filter');
  });

  it('test_get_user_simulator_instructions_template_with_bad_custom_instructions_raises_error', () => {
    expect(() =>
      getUserSimulatorInstructionsTemplate('custom instructions', {
        id: 'test_persona',
        description: 'Test persona',
        behaviors: [],
      }),
    ).toThrowError(InputValidationError);
  });

  it('returns custom instructions that name every placeholder a persona needs', () => {
    const customInstructions =
      '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}' +
      ' {{ persona.description }}';

    expect(
      getUserSimulatorInstructionsTemplate(customInstructions, SAMPLE_PERSONA),
    ).toBe(customInstructions);
  });
});

describe('TestGetLlmBackedUserSimulatorPrompt', () => {
  it('test_get_llm_backed_user_simulator_prompt_default', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
    });

    expect(prompt).toContain('# Conversation Plan\n\ntest plan');
    expect(prompt).toContain('# Conversation History\n\ntest history');
    expect(prompt).toContain('Output `test stop` to indicate');
    expect(prompt).not.toContain('{{');
  });

  it('test_get_llm_backed_user_simulator_prompt_with_custom_instructions', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      customInstructions: `Custom instructions:

# Past history
{{ conversation_history }}

# Plan
{{ conversation_plan }}

# Finished!
{{ stop_signal }}`,
    });

    expect(prompt).toBe(`Custom instructions:

# Past history
test history

# Plan
test plan

# Finished!
test stop`);
  });

  it('test_get_llm_backed_user_simulator_prompt_with_persona', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      customInstructions: PERSONA_INSTRUCTIONS,
      userPersona: SAMPLE_PERSONA,
    });

    expect(prompt).toBe(`Persona template

# Persona Description
Test persona description

## Test behavior
Test behavior description

Instructions:
  * instruction 1
  * instruction 2

# Conversation Plan
test plan

# Conversation History
test history

# Stop signal
test stop`);
  });

  it('renders the built-in persona template', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona: SAMPLE_PERSONA,
    });

    expect(prompt).toContain('Test persona description');
    expect(prompt).toContain('## Test behavior');
    expect(prompt).toContain(
      'Instructions:\n  * instruction 1\n  * instruction 2',
    );
    expect(prompt).toContain('# Conversation Plan\n\ntest plan');
    expect(prompt).toContain('# Conversation History\n\ntest history');
    expect(prompt).not.toContain('{{');
  });

  it('test_get_llm_backed_user_simulator_prompt_renders_persona_templates_in_sandbox', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona: {
        id: 'test_persona',
        description: 'Test persona description',
        behaviors: [
          {
            name: 'Behavior {{ stop_signal }}',
            description: 'Description {{ stop_signal }}',
            behaviorInstructions: ['instruction {{ stop_signal }}'],
            violationRubrics: ['rubric 1'],
          },
        ],
      },
    });

    expect(prompt).toContain('## Behavior test stop');
    expect(prompt).toContain('Description test stop');
    expect(prompt).toContain('  * instruction test stop');
  });

  it('test_get_llm_backed_user_simulator_prompt_blocks_unsafe_persona_templates', () => {
    // Divergence: adk-python compiles a persona field with Jinja's
    // `SandboxedEnvironment`, which raises `SecurityError`. adk-js interpolates
    // the field instead of compiling it, so the expression cannot run and
    // renders empty. Matching adk-python would mean compiling the field, which
    // is the risk the interpolation removes.
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona: {
        id: 'test_persona',
        description: 'Test persona description',
        behaviors: [
          {
            name: "{{ ''.constructor.constructor('return 1')() }}",
            description: 'Test behavior description',
            behaviorInstructions: ['instruction 1'],
            violationRubrics: ['rubric 1'],
          },
        ],
      },
    });

    expect(prompt).toContain('## \n');
    expect(prompt).not.toContain('constructor');
    expect(prompt).not.toContain('return 1');
  });

  it('renders a persona field naming an unknown variable as empty', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona: {
        id: 'test_persona',
        description: 'Test persona description',
        behaviors: [
          {
            name: 'Behavior {{ stop_signal.missing }}',
            description: '',
            behaviorInstructions: ['instruction {{ no_such_variable }}'],
            violationRubrics: ['rubric 1'],
          },
        ],
      },
    });

    expect(prompt).toContain('## Behavior \n');
    expect(prompt).toContain('  * instruction \n');
  });
});

describe('TestIsValidUserSimulatorTemplate', () => {
  it('test_valid_template', () => {
    expect(isValidUserSimulatorTemplate('Hello {{ name }}', ['name'])).toBe(
      true,
    );
  });

  it('test_invalid_syntax', () => {
    expect(isValidUserSimulatorTemplate('Hello {{ name', ['name'])).toBe(false);
  });

  it('test_missing_parameter', () => {
    expect(isValidUserSimulatorTemplate('Hello', ['name'])).toBe(false);
  });

  it('reads a member access as a reference to the object alone', () => {
    expect(
      isValidUserSimulatorTemplate('Hello {{ persona.name }}', ['persona']),
    ).toBe(true);
    expect(
      isValidUserSimulatorTemplate('Hello {{ persona.name }}', ['name']),
    ).toBe(false);
  });
});
