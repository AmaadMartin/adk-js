/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ConversationScenario,
  getDefaultPersonaRegistry,
  NotFoundError,
  UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ConversationScenario', () => {
  it('constructs without a persona', () => {
    const scenario = new ConversationScenario({
      startingPrompt: 'Hello',
      conversationPlan: 'test plan',
    });
    expect(scenario.startingPrompt).toBe('Hello');
    expect(scenario.conversationPlan).toBe('test plan');
    expect(scenario.userPersona).toBeUndefined();
  });

  it('resolves a persona id string to the matching default persona', () => {
    const scenario = new ConversationScenario({
      startingPrompt: 'Hello',
      conversationPlan: 'test plan',
      userPersona: 'EXPERT',
    });
    expect(scenario.userPersona).toEqual(
      getDefaultPersonaRegistry().getPersona('EXPERT'),
    );
  });

  it('throws NotFoundError for an unknown persona id', () => {
    expect(
      () =>
        new ConversationScenario({
          startingPrompt: 'Hello',
          conversationPlan: 'test plan',
          userPersona: 'DOES_NOT_EXIST',
        }),
    ).toThrow(NotFoundError);
  });

  it('passes a UserPersona object through unchanged', () => {
    const persona: UserPersona = {
      id: 'custom',
      description: 'A custom persona',
      behaviors: [],
    };
    const scenario = new ConversationScenario({
      startingPrompt: 'Hello',
      conversationPlan: 'test plan',
      userPersona: persona,
    });
    expect(scenario.userPersona).toBe(persona);
  });
});
