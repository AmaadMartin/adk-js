/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/evaluation/simulation/test_llm_backed_user_simulator_prompts.py
// (main).

import {
  UserPersona,
  getLlmBackedUserSimulatorPrompt,
  isValidUserSimulatorTemplate,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE,
  USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE,
  getUserSimulatorInstructionsTemplate,
} from '../../../src/evaluation/simulation/llm_backed_user_simulator_prompts.js';

/**
 * Stands in for the default template. adk-python monkeypatches the module
 * constant; a TypeScript module constant cannot be replaced, so the same
 * template is passed in as custom instructions instead.
 */
const MOCK_DEFAULT_TEMPLATE = `Default template

# Conversation Plan
{{conversation_plan}}

# Conversation History
{{conversation_history}}

# Stop signal
{{stop_signal}}`;

/**
 * Stands in for the persona template, for the same reason. adk-python's mock
 * loops over `persona.behaviors` in the template; the renderer builds that
 * block, so the placeholder takes the loop's place. The expected output below
 * is adk-python's, unchanged.
 */
const MOCK_PERSONA_TEMPLATE = `Persona template

# Persona Description
{{persona.description}}
{{persona.behaviors}}
# Conversation Plan
{{conversation_plan}}

# Conversation History
{{conversation_history}}

# Stop signal
{{stop_signal}}`;

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

describe('getUserSimulatorInstructionsTemplate', () => {
  // Ports test_get_user_simulator_instructions_template_default.
  it('returns the default template when nothing is customized', () => {
    expect(getUserSimulatorInstructionsTemplate()).toBe(
      DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE,
    );
  });

  // Ports test_get_user_simulator_instructions_template_with_custom_instructions.
  it('returns the custom instructions when there is no persona', () => {
    const customInstructions = 'custom instructions';

    expect(getUserSimulatorInstructionsTemplate({customInstructions})).toBe(
      customInstructions,
    );
  });

  // Ports test_get_user_simulator_instructions_template_with_persona.
  it('returns the persona template when a persona is given', () => {
    const userPersona: UserPersona = {
      id: 'test_persona',
      description: 'Test persona',
      behaviors: [],
    };

    expect(getUserSimulatorInstructionsTemplate({userPersona})).toBe(
      USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE,
    );
  });

  // Ports
  // test_get_user_simulator_instructions_template_with_bad_custom_instructions_raises_error.
  it('rejects custom instructions with a persona but no persona placeholder', () => {
    const userPersona: UserPersona = {
      id: 'test_persona',
      description: 'Test persona',
      behaviors: [],
    };

    expect(() =>
      getUserSimulatorInstructionsTemplate({
        customInstructions: 'custom instructions',
        userPersona,
      }),
    ).toThrowError(
      /Custom instructions using personas must contain the following formatting placeholders/,
    );
  });

  it('accepts custom instructions with a persona and every placeholder', () => {
    const customInstructions =
      '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}' +
      ' {{ persona.description }}';

    expect(
      getUserSimulatorInstructionsTemplate({
        customInstructions,
        userPersona: SAMPLE_PERSONA,
      }),
    ).toBe(customInstructions);
  });
});

describe('getLlmBackedUserSimulatorPrompt', () => {
  // Ports test_get_llm_backed_user_simulator_prompt_default.
  it('renders the plan, the history and the stop signal', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      customInstructions: MOCK_DEFAULT_TEMPLATE,
    });

    expect(prompt).toBe(`Default template

# Conversation Plan
test plan

# Conversation History
test history

# Stop signal
test stop`);
  });

  it('renders the shipped default template', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
    });

    expect(prompt).toContain('You are a Simulated User designed to test an AI');
    expect(prompt).toContain('Output `test stop` to indicate');
    expect(prompt).toContain('test plan');
    expect(prompt).toContain('test history');
  });

  // Ports test_get_llm_backed_user_simulator_prompt_with_custom_instructions.
  it('renders custom instructions', () => {
    const customInstructions = `Custom instructions:

# Past history
{{conversation_plan}}

# Plan
{{conversation_plan}}

# Finished!
{{stop_signal}}`;

    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      customInstructions,
    });

    expect(prompt).toBe(`Custom instructions:

# Past history
test plan

# Plan
test plan

# Finished!
test stop`);
  });

  // Ports test_get_llm_backed_user_simulator_prompt_with_persona.
  it('renders a persona and its behavior instructions', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      customInstructions: MOCK_PERSONA_TEMPLATE,
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

  it('renders the shipped persona template', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona: SAMPLE_PERSONA,
    });

    expect(prompt).toContain('Test persona description');
    expect(prompt).toContain('## Test behavior');
    expect(prompt).toContain('  * instruction 1');
  });

  // Ports
  // test_get_llm_backed_user_simulator_prompt_renders_persona_templates_in_sandbox.
  it('renders the placeholders a persona writes into its own text', () => {
    const userPersona: UserPersona = {
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
    };

    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona,
    });

    expect(prompt).toContain('## Behavior test stop');
    expect(prompt).toContain('Description test stop');
    expect(prompt).toContain('  * instruction test stop');
  });

  it('renders a behavior that has no text as an empty string', () => {
    const userPersona: UserPersona = {
      id: 'test_persona',
      description: 'Test persona description',
      behaviors: [
        {
          name: '',
          description: '',
          behaviorInstructions: [],
          violationRubrics: [],
        },
      ],
    };

    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona,
    });

    expect(prompt).toContain('## \n');
  });

  it('does not escape a plan that contains markup', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'ask for a price < 150 & a "morning" flight',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
    });

    expect(prompt).toContain('ask for a price < 150 & a "morning" flight');
  });

  it('inserts a value containing a replacement pattern literally', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'cost $& and $` and $1',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
    });

    expect(prompt).toContain('cost $& and $` and $1');
  });
});

// Ports test_get_llm_backed_user_simulator_prompt_blocks_unsafe_persona_templates.
// adk-python renders in a Jinja2 SandboxedEnvironment and raises SecurityError
// on `{{ ''.__class__.__mro__ }}`. JavaScript has no `__mro__`, and its
// equivalent escape reaches `Function` through any value's `constructor`. The
// renderer substitutes names and evaluates nothing, so the payload is inert
// rather than refused.
describe('untrusted template text', () => {
  // The payload builds its marker by concatenation, so the marker appears in
  // the prompt only if the payload ran.
  const CODE_PAYLOAD = `{{ range.constructor("return 'PWN' + 'ED'")() }}`;

  it('does not execute code a persona writes into its name', () => {
    const userPersona: UserPersona = {
      id: 'test_persona',
      description: 'Test persona description',
      behaviors: [
        {
          name: CODE_PAYLOAD,
          description: 'Test behavior description',
          behaviorInstructions: ['instruction 1'],
          violationRubrics: ['rubric 1'],
        },
      ],
    };

    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona,
    });

    expect(prompt).not.toContain('PWNED');
    expect(prompt).toContain(`## ${CODE_PAYLOAD}`);
  });

  it('does not execute code a persona writes into its description', () => {
    const userPersona: UserPersona = {
      id: 'test_persona',
      description: `Test persona ${CODE_PAYLOAD}`,
      behaviors: [],
    };

    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona,
    });

    expect(prompt).not.toContain('PWNED');
    expect(prompt).toContain(`Test persona ${CODE_PAYLOAD}`);
  });

  it('does not execute code a behavior instruction carries', () => {
    const userPersona: UserPersona = {
      id: 'test_persona',
      description: 'Test persona description',
      behaviors: [
        {
          name: 'Test behavior',
          description: 'Test behavior description',
          behaviorInstructions: [CODE_PAYLOAD],
          violationRubrics: ['rubric 1'],
        },
      ],
    };

    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona,
    });

    expect(prompt).not.toContain('PWNED');
    expect(prompt).toContain(`  * ${CODE_PAYLOAD}`);
  });

  it('rejects custom instructions that carry an expression', () => {
    const customInstructions =
      '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}' +
      ` ${CODE_PAYLOAD}`;

    expect(
      isValidUserSimulatorTemplate(customInstructions, [
        'stop_signal',
        'conversation_plan',
        'conversation_history',
      ]),
    ).toBe(false);
  });

  it('renders no value for a placeholder naming an object member', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      customInstructions:
        '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}' +
        ' [{{ persona.constructor }}] [{{ persona.__proto__ }}]' +
        ' [{{ constructor }}]',
      userPersona: SAMPLE_PERSONA,
    });

    expect(prompt).toContain('[] [] []');
  });
});

describe('isValidUserSimulatorTemplate', () => {
  // Ports test_valid_template.
  it('accepts a template that references the required parameter', () => {
    expect(isValidUserSimulatorTemplate('Hello {{ name }}', ['name'])).toBe(
      true,
    );
  });

  // Ports test_invalid_syntax.
  it('rejects a template that does not parse', () => {
    expect(isValidUserSimulatorTemplate('Hello {{ name', ['name'])).toBe(false);
  });

  // Ports test_missing_parameter.
  it('rejects a template that references no required parameter', () => {
    expect(isValidUserSimulatorTemplate('Hello', ['name'])).toBe(false);
  });

  it('rejects a template that uses a Jinja statement', () => {
    expect(
      isValidUserSimulatorTemplate('{{ name }}{% if name %}hi{% endif %}', [
        'name',
      ]),
    ).toBe(false);
  });

  it('rejects a template whose placeholder holds an expression', () => {
    expect(isValidUserSimulatorTemplate('{{ name | upper }}', ['name'])).toBe(
      false,
    );
  });

  it('rejects a name quoted inside a placeholder', () => {
    expect(isValidUserSimulatorTemplate('{{ "name" }}', ['name'])).toBe(false);
  });

  it('rejects a required name that is only a field of another', () => {
    expect(isValidUserSimulatorTemplate('{{ other.name }}', ['name'])).toBe(
      false,
    );
  });

  it('accepts a parameter referenced through an attribute', () => {
    expect(
      isValidUserSimulatorTemplate('{{ persona.description }}', ['persona']),
    ).toBe(true);
  });

  it('rejects a template that mentions the name outside an expression', () => {
    expect(isValidUserSimulatorTemplate('name is required', ['name'])).toBe(
      false,
    );
  });
});
