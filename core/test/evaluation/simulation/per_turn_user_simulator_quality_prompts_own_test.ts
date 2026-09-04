/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers what a persona field may hold, which is the only untrusted input the
 * judge prompt renders. The tests ported from adk-python live in
 * `per_turn_user_simulator_quality_prompts_test.ts`.
 */

import {
  getPerTurnUserSimulatorQualityPrompt,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function renderWithBehaviorName(name: string): string {
  return renderWithPersona({
    id: 'test_persona',
    description: 'Test persona description.',
    behaviors: [
      {
        name,
        description: 'Test behavior description.',
        behaviorInstructions: ['instruction1'],
        violationRubrics: ['violation1'],
      },
    ],
  });
}

function renderWithPersona(userPersona: UserPersona): string {
  return getPerTurnUserSimulatorQualityPrompt({
    conversationPlan: 'plan',
    conversationHistory: 'history',
    generatedUserResponse: 'response',
    stopSignal: 'stop',
    userPersona,
  });
}

describe('getPerTurnUserSimulatorQualityPrompt', () => {
  it('renders a persona field naming an unknown variable as empty', () => {
    expect(renderWithBehaviorName('{{ no_such_variable }}')).toContain(
      '## Criteria: \n',
    );
  });

  it('renders a persona field naming an unknown property as empty', () => {
    expect(renderWithBehaviorName('{{ persona.no_such_property }}')).toContain(
      '## Criteria: \n',
    );
  });

  it('renders a persona field walking the prototype as empty', () => {
    // `constructor` is inherited, not an own property, so the walk stops.
    expect(renderWithBehaviorName('{{ stop_signal.constructor }}')).toContain(
      '## Criteria: \n',
    );
  });

  it('keeps an empty persona field empty', () => {
    expect(renderWithBehaviorName('')).toContain('## Criteria: \n');
  });

  it('renders every behavior and every violation rubric', () => {
    const prompt = renderWithPersona({
      id: 'thorough',
      description: 'A thorough user.',
      behaviors: [
        {
          name: 'first',
          description: 'The first behavior.',
          behaviorInstructions: ['do this'],
          violationRubrics: ['broke one', 'broke two'],
        },
        {
          name: 'second',
          description: 'The second behavior.',
          behaviorInstructions: ['do that'],
          violationRubrics: ['broke three'],
        },
      ],
    });

    expect(prompt).toContain('## Criteria: first');
    expect(prompt).toContain('  * broke one\n  * broke two\n');
    expect(prompt).toContain('## Criteria: second');
    expect(prompt).toContain('  * broke three\n');
  });

  it('renders a persona with no behaviors', () => {
    const prompt = renderWithPersona({
      id: 'plain',
      description: 'A plain user.',
      behaviors: [],
    });

    expect(prompt).toContain('# Persona Description\nA plain user.');
    expect(prompt).not.toContain('## Criteria:');
  });

  it('substitutes the stop signal everywhere the template names it', () => {
    const prompt = getPerTurnUserSimulatorQualityPrompt({
      conversationPlan: 'plan',
      conversationHistory: 'history',
      generatedUserResponse: 'response',
      stopSignal: '</finished>',
    });

    expect(prompt.match(/`<\/finished>`/g)).toHaveLength(6);
  });
});
