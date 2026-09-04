/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases the adk-python reference tests do not cover: what the renderer does
 * with an expression it does not recognize, and with more than one behavior.
 */

import {
  getPerTurnUserSimulatorQualityPrompt,
  type UserBehavior,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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
