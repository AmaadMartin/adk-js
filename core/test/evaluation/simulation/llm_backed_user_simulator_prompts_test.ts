/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getLlmBackedUserSimulatorPrompt,
  isValidUserSimulatorTemplate,
  UserPersona,
  UserSimulatorTemplates,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

// Template selection and the template constants port adk-python privates and
// are intentionally internal, so they are imported via a relative path.
import {
  DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE,
  getUserSimulatorInstructionsTemplate,
  USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE,
} from '../../../src/evaluation/simulation/llm_backed_user_simulator_prompts.js';

const MOCK_DEFAULT_TEMPLATE = `Default template

# Conversation Plan
{{conversation_plan}}

# Conversation History
{{conversation_history}}

# Stop signal
{{stop_signal}}`;

const MOCK_PERSONA_TEMPLATE = `Persona template

# Persona Description
{{persona.description}}
{% for b in persona.behaviors %}
## {{ b.name }}
{{ b.description }}

Instructions:
{{ b.get_behavior_instructions_str() }}
{% endfor %}
# Conversation Plan
{{conversation_plan}}

# Conversation History
{{conversation_history}}

# Stop signal
{{stop_signal}}`;

const MOCK_TEMPLATES: UserSimulatorTemplates = {
  default: MOCK_DEFAULT_TEMPLATE,
  withPersona: MOCK_PERSONA_TEMPLATE,
};

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
  it('returns the default template with no custom instructions or persona', () => {
    expect(getUserSimulatorInstructionsTemplate()).toBe(
      DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE,
    );
  });

  it('returns the custom instructions when provided', () => {
    const customInstructions = 'custom instructions';
    expect(getUserSimulatorInstructionsTemplate(customInstructions)).toBe(
      customInstructions,
    );
  });

  it('returns the persona template when a persona is provided', () => {
    expect(
      getUserSimulatorInstructionsTemplate(undefined, SAMPLE_PERSONA),
    ).toBe(USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE);
  });

  it('throws for bad custom instructions with a persona', () => {
    expect(() =>
      getUserSimulatorInstructionsTemplate(
        'custom instructions',
        SAMPLE_PERSONA,
      ),
    ).toThrow();
  });

  it('returns valid custom instructions with a persona', () => {
    const custom =
      '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}' +
      ' {{ persona }}';
    expect(getUserSimulatorInstructionsTemplate(custom, SAMPLE_PERSONA)).toBe(
      custom,
    );
  });
});

describe('getLlmBackedUserSimulatorPrompt', () => {
  it('renders the default template', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      templates: MOCK_TEMPLATES,
    });
    expect(prompt).toBe(
      `Default template

# Conversation Plan
test plan

# Conversation History
test history

# Stop signal
test stop`,
    );
  });

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
    expect(prompt).toBe(
      `Custom instructions:

# Past history
test plan

# Plan
test plan

# Finished!
test stop`,
    );
  });

  it('renders the persona template', () => {
    const prompt = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona: SAMPLE_PERSONA,
      templates: MOCK_TEMPLATES,
    });
    expect(prompt).toBe(
      `Persona template

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
test stop`,
    );
  });

  it('re-renders persona sub-field templates against the context', () => {
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

  // Divergence from adk-python: Jinja's SandboxedEnvironment raises a
  // SecurityError for `{{ ''.__class__.__mro__ }}` (Python-internal access). In
  // JS that expression is inert, but nunjucks is NOT sandboxed against
  // `constructor.constructor(...)` SSTI. The port re-renders persona sub-fields
  // with a restricted variable-only interpolation, so injected template syntax
  // is contained and cannot execute code.
  it('contains template injection in persona fields', () => {
    const makePersona = (name: string): UserPersona => ({
      id: 'test_persona',
      description: 'Test persona description',
      behaviors: [
        {
          name,
          description: 'Test behavior description',
          behaviorInstructions: ['instruction 1'],
          violationRubrics: ['rubric 1'],
        },
      ],
    });

    // A JS SSTI attempt must NOT execute (would otherwise render "7").
    const ssti = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona: makePersona("{{ constructor.constructor('return 7')() }}"),
    });
    expect(ssti).not.toContain('7');
    expect(ssti).not.toContain('function');

    // The Python attack string renders inert (empty) rather than throwing.
    const pythonAttack = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'test plan',
      conversationHistory: 'test history',
      stopSignal: 'test stop',
      userPersona: makePersona("{{ ''.__class__.__mro__ }}"),
    });
    expect(pythonAttack).toContain('## \n');
  });

  // The nunjucks environment and its `render_string_filter` are module-level
  // and therefore shared by every call; the filter reads its variables from the
  // render context, so consecutive renders must not bleed into each other.
  it('keeps per-render context isolated across successive renders', () => {
    const makePersona = (): UserPersona => ({
      id: 'test_persona',
      description: 'Test persona description',
      behaviors: [
        {
          name: 'Behavior {{ stop_signal }}',
          description: 'Plan {{ conversation_plan }}',
          behaviorInstructions: ['instruction 1'],
          violationRubrics: ['rubric 1'],
        },
      ],
    });

    const first = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'first plan',
      conversationHistory: 'first history',
      stopSignal: 'first stop',
      userPersona: makePersona(),
    });
    const second = getLlmBackedUserSimulatorPrompt({
      conversationPlan: 'second plan',
      conversationHistory: 'second history',
      stopSignal: 'second stop',
      userPersona: makePersona(),
    });

    expect(first).toContain('## Behavior first stop');
    expect(first).toContain('Plan first plan');
    expect(second).toContain('## Behavior second stop');
    expect(second).toContain('Plan second plan');
    expect(second).not.toContain('first');
  });

  it('resolves only simple own-property context variables', () => {
    const userPersona: UserPersona = {
      id: 'test_persona',
      description: 'Test persona description',
      behaviors: [
        {
          // `{{ stop_signal }}` resolves; `{{ constructor }}` (prototype
          // property, not own) and `{{ stop_signal.nested }}` (access on a
          // primitive) both render inert.
          name: '{{ stop_signal }}',
          description: '{{ constructor }}',
          behaviorInstructions: ['{{ stop_signal.nested }}'],
          violationRubrics: ['rubric 1'],
        },
        {
          // Empty instructions exercise the empty-string path of the
          // render_string_filter.
          name: 'plain',
          description: 'plain',
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
    expect(prompt).toContain('## test stop');
    expect(prompt).not.toContain('function');
    expect(prompt).not.toContain('[object');
  });
});

describe('isValidUserSimulatorTemplate', () => {
  it('returns true for a valid template with the required param', () => {
    expect(isValidUserSimulatorTemplate('Hello {{ name }}', ['name'])).toBe(
      true,
    );
  });

  it('returns false for invalid syntax', () => {
    expect(isValidUserSimulatorTemplate('Hello {{ name', ['name'])).toBe(false);
  });

  it('returns false when a required param is missing', () => {
    expect(isValidUserSimulatorTemplate('Hello', ['name'])).toBe(false);
  });

  it('finds params referenced inside loop and expression blocks', () => {
    const template = '{% for b in persona %}{{ b }}{% endfor %}';
    expect(isValidUserSimulatorTemplate(template, ['persona'])).toBe(true);
  });
});
