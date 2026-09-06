/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ConversationGenerationConfigSchema,
  ConversationScenarioSchema,
  ConversationScenariosSchema,
  UserPersonaSchema,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/conversation_scenarios', () => {
  describe('ConversationScenarioSchema', () => {
    it('parses required fields without a persona', () => {
      const scenario = ConversationScenarioSchema.parse({
        startingPrompt: 'I need to book a flight.',
        conversationPlan: 'Book a one-way flight.',
      });
      expect(scenario.startingPrompt).toBe('I need to book a flight.');
      expect(scenario.userPersona).toBeUndefined();
    });

    it('parses with a user persona object', () => {
      const persona = UserPersonaSchema.parse({
        id: 'p',
        description: 'd',
        behaviors: [],
      });
      const scenario = ConversationScenarioSchema.parse({
        startingPrompt: 'hi',
        conversationPlan: 'plan',
        userPersona: persona,
      });
      expect(scenario.userPersona?.id).toBe('p');
    });

    it('rejects unknown keys (strict)', () => {
      expect(
        ConversationScenarioSchema.safeParse({
          startingPrompt: 'a',
          conversationPlan: 'b',
          extra: 1,
        }).success,
      ).toBe(false);
    });
  });

  describe('ConversationScenariosSchema', () => {
    it('defaults scenarios to an empty array', () => {
      expect(ConversationScenariosSchema.parse({}).scenarios).toEqual([]);
    });

    it('parses a list of scenarios', () => {
      const scenarios = ConversationScenariosSchema.parse({
        scenarios: [{startingPrompt: 'a', conversationPlan: 'b'}],
      });
      expect(scenarios.scenarios).toHaveLength(1);
    });
  });

  describe('ConversationGenerationConfigSchema', () => {
    it('parses required and optional fields', () => {
      const config = ConversationGenerationConfigSchema.parse({
        count: 3,
        generationInstruction: 'generate diverse scenarios',
        environmentContext: 'available models: a, b',
        modelName: 'gemini-2.5-flash',
      });
      expect(config.count).toBe(3);
      expect(config.modelName).toBe('gemini-2.5-flash');
    });

    it('leaves optional fields undefined', () => {
      const config = ConversationGenerationConfigSchema.parse({
        count: 1,
        modelName: 'gemini-2.5-flash',
      });
      expect(config.generationInstruction).toBeUndefined();
      expect(config.environmentContext).toBeUndefined();
    });

    it('rejects unknown keys (strict)', () => {
      expect(
        ConversationGenerationConfigSchema.safeParse({
          count: 1,
          modelName: 'm',
          extra: 1,
        }).success,
      ).toBe(false);
    });
  });
});
