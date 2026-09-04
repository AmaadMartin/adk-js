/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PRE_BUILT_BEHAVIORS,
  UserPersona,
  getDefaultPersonaRegistry,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const BEHAVIOR_ENTRIES = Object.entries(PRE_BUILT_BEHAVIORS);

describe('getDefaultPersonaRegistry', () => {
  it('holds exactly the three pre-built personas, in reference order', () => {
    const registry = getDefaultPersonaRegistry();
    expect(registry.getRegisteredPersonas().map((p) => p.id)).toEqual([
      'EXPERT',
      'NOVICE',
      'EVALUATOR',
    ]);
  });

  it('returns registries that do not share state', () => {
    const mine: UserPersona = {
      id: 'EXPERT',
      description: 'A stricter expert.',
      behaviors: [PRE_BUILT_BEHAVIORS.TONE_PROFESSIONAL],
    };
    const first = getDefaultPersonaRegistry();
    first.registerPersona('EXPERT', mine);

    expect(first.getPersona('EXPERT')).toBe(mine);
    expect(getDefaultPersonaRegistry().getPersona('EXPERT')).not.toBe(mine);
  });

  it('gives every persona a description', () => {
    for (const persona of getDefaultPersonaRegistry().getRegisteredPersonas()) {
      expect(persona.description, persona.id).not.toBe('');
    }
  });
});

describe('PRE_BUILT_BEHAVIORS', () => {
  it('carries the eleven reference behaviors, in reference order', () => {
    expect(Object.keys(PRE_BUILT_BEHAVIORS)).toEqual([
      'ADVANCE_DETAIL_ORIENTED',
      'ADVANCE_GOAL_ORIENTED',
      'ANSWER_RELEVANT_ONLY',
      'ANSWER_ALL',
      'CORRECT_AGENT',
      'DO_NOT_CORRECT_AGENT',
      'TROUBLESHOOT_ONCE',
      'END_LIMITED_TROUBLESHOOTING',
      'END_NO_TROUBLESHOOTING',
      'TONE_PROFESSIONAL',
      'TONE_CONVERSATIONAL',
    ]);
  });

  it.each(BEHAVIOR_ENTRIES)('describes and populates %s', (name, behavior) => {
    expect(behavior.name, name).not.toBe('');
    expect(behavior.description, name).not.toBe('');
    expect(behavior.behaviorInstructions, name).not.toEqual([]);
    expect(behavior.violationRubrics, name).not.toEqual([]);
  });

  it('is frozen, so one caller cannot edit the shared catalogue', () => {
    expect(Object.isFrozen(PRE_BUILT_BEHAVIORS)).toBe(true);
  });
});

// The prompt text is compared against what adk-python feeds the same model, so
// its quirks are the contract. These assertions fail a well-meaning typo fix.
describe('reference prompt text', () => {
  it('keeps the missing space in ADVANCE_DETAIL_ORIENTED', () => {
    expect(PRE_BUILT_BEHAVIORS.ADVANCE_DETAIL_ORIENTED.description).toContain(
      'stick to the Conversation Plan.When starting a new request',
    );
  });

  it('keeps the leading space in END_NO_TROUBLESHOOTING', () => {
    expect(PRE_BUILT_BEHAVIORS.END_NO_TROUBLESHOOTING.description).toMatch(
      /^ A conversation is considered completed/,
    );
  });

  it('keeps the stop_signal placeholder unsubstituted', () => {
    expect(
      PRE_BUILT_BEHAVIORS.DO_NOT_CORRECT_AGENT.behaviorInstructions,
    ).toEqual([
      'If the Agent made an illogical or incorrect statement, end the conversation with `{{ stop_signal }}`.',
    ]);
  });
});
