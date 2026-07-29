/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ConversationScenario, EvalCase, Invocation} from '@google/adk';
import {describe, expect, it} from 'vitest';

const CONVERSATION: Invocation[] = [
  {invocationId: 'inv1', userContent: {parts: [{text: 'Hello!'}]}},
];

const SCENARIO = new ConversationScenario({
  startingPrompt: 'Hello!',
  conversationPlan: 'test plan',
});

describe('EvalCase', () => {
  it('accepts a static conversation', () => {
    const evalCase = new EvalCase({
      evalId: 'test_eval_id',
      conversation: CONVERSATION,
    });
    expect(evalCase.evalId).toBe('test_eval_id');
    expect(evalCase.conversation).toBe(CONVERSATION);
    expect(evalCase.conversationScenario).toBeUndefined();
  });

  it('accepts a conversation scenario', () => {
    const evalCase = new EvalCase({
      evalId: 'test_eval_id',
      conversationScenario: SCENARIO,
    });
    expect(evalCase.conversationScenario).toBe(SCENARIO);
    expect(evalCase.conversation).toBeUndefined();
  });

  it('rejects providing both conversation and scenario', () => {
    expect(
      () =>
        new EvalCase({
          evalId: 'test_eval_id',
          conversation: CONVERSATION,
          conversationScenario: SCENARIO,
        }),
    ).toThrow('Both static invocations and conversation scenario');
  });

  it('rejects providing neither conversation nor scenario', () => {
    expect(() => new EvalCase({evalId: 'test_eval_id'})).toThrow(
      'Neither static invocations nor conversation scenario',
    );
  });
});
