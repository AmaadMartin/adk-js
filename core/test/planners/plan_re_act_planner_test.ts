/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PlanReActPlanner,
  PluginManager,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function makeCallbackContext(): Context {
  return new Context({invocationContext: makeInvocationContext()});
}

function functionCallNames(parts: Part[]): string[] {
  return parts
    .map((part) => part.functionCall?.name)
    .filter((name): name is string => name !== undefined);
}

function process(responseParts: Part[]): Part[] {
  const result = new PlanReActPlanner().processPlanningResponse(
    makeCallbackContext(),
    responseParts,
  );
  if (result === undefined) {
    expect.fail('processPlanningResponse returned undefined');
  }
  return result;
}

describe('PlanReActPlanner.buildPlanningInstruction', () => {
  it('names every tag the planner asks the model to emit', () => {
    const instruction = new PlanReActPlanner().buildPlanningInstruction(
      new ReadonlyContext(makeInvocationContext()),
      {contents: [], toolsDict: {}, liveConnectConfig: {}} satisfies LlmRequest,
    );

    for (const tag of [
      '/*PLANNING*/',
      '/*REPLANNING*/',
      '/*REASONING*/',
      '/*ACTION*/',
      '/*FINAL_ANSWER*/',
    ]) {
      expect(instruction).toContain(tag);
    }
  });

  it('returns the same string on every call', () => {
    const planner = new PlanReActPlanner();
    const readonlyContext = new ReadonlyContext(makeInvocationContext());
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    expect(planner.buildPlanningInstruction(readonlyContext, request)).toBe(
      planner.buildPlanningInstruction(readonlyContext, request),
    );
  });
});

describe('PlanReActPlanner.processPlanningResponse', () => {
  it('returns undefined for an empty response', () => {
    const planner = new PlanReActPlanner();

    expect(
      planner.processPlanningResponse(makeCallbackContext(), []),
    ).toBeUndefined();
  });

  it('strips planning tags from thought parts and keeps their metadata', () => {
    const result = process([
      {text: '/*PLANNING*/Step 1: look it up.', thoughtSignature: 'sig1'},
      {text: '/*REASONING*/I need to call the tool.', thoughtSignature: 'sig2'},
      {functionCall: {name: 'lookup', args: {q: 'test'}}},
    ]);

    const textParts = result.filter((part) => part.text);
    expect(textParts.map((part) => part.text)).toEqual([
      'Step 1: look it up.',
      'I need to call the tool.',
    ]);
    expect(textParts.every((part) => part.thought === true)).toBe(true);
    expect(textParts.map((part) => part.thoughtSignature)).toEqual([
      'sig1',
      'sig2',
    ]);
    expect(functionCallNames(result)).toEqual(['lookup']);
  });

  it('splits on the final answer tag and drops it from both blocks', () => {
    const result = process([
      {text: '/*REASONING*/Some reasoning./*FINAL_ANSWER*/The answer is 42.'},
    ]);

    expect(result).toEqual([
      {text: 'Some reasoning.', thought: true},
      {text: 'The answer is 42.'},
    ]);
  });

  it('strips planning tags embedded before the final answer', () => {
    const result = process([
      {
        text:
          '/*PLANNING*/Initial plan.\n' +
          '/*REASONING*/Some reasoning.\n' +
          '/*FINAL_ANSWER*/The answer is 42.',
      },
    ]);

    const combined = result.map((part) => part.text).join(' ');
    expect(combined).not.toContain('/*');
    expect(combined).toContain('Initial plan.');
    expect(combined).toContain('Some reasoning.');
    expect(combined).toContain('The answer is 42.');
  });

  it('emits only the answer when nothing precedes the final answer tag', () => {
    const result = process([{text: '/*FINAL_ANSWER*/Just the answer.'}]);

    expect(result).toEqual([{text: 'Just the answer.'}]);
  });

  it('emits only the reasoning when nothing follows the final answer tag', () => {
    const result = process([
      {text: '/*REASONING*/Only reasoning./*FINAL_ANSWER*/'},
    ]);

    expect(result).toEqual([{text: 'Only reasoning.', thought: true}]);
  });

  it('leaves a part without a leading tag untouched', () => {
    const result = process([
      {text: 'Here is the answer /*PLANNING*/ with stray tag.'},
    ]);

    expect(result).toEqual([
      {text: 'Here is the answer /*PLANNING*/ with stray tag.'},
    ]);
  });

  it('keeps a part that is only a tag, stripped and marked as thought', () => {
    const result = process([
      {text: '/*ACTION*/'},
      {functionCall: {name: 'lookup', args: {q: 'test'}}},
    ]);

    expect(result[0]).toEqual({text: '', thought: true});
    expect(functionCallNames(result)).toEqual(['lookup']);
  });

  it('keeps a sole bare tag part as a thought', () => {
    const result = process([{text: '/*ACTION*/'}]);

    expect(result).toEqual([{text: '', thought: true}]);
  });

  it('preserves a non-text part that carries no tag', () => {
    const inlineDataPart: Part = {
      inlineData: {mimeType: 'image/png', data: 'AAA='},
    };

    const result = process([inlineDataPart]);

    expect(result).toEqual([inlineDataPart]);
  });

  it('preserves all leading parallel function calls', () => {
    const result = process([
      {functionCall: {name: 'get_weather', args: {city: 'SF'}}},
      {functionCall: {name: 'get_time', args: {city: 'SF'}}},
    ]);

    expect(functionCallNames(result)).toEqual(['get_weather', 'get_time']);
  });

  it('preserves parallel function calls that follow leading text', () => {
    const result = process([
      {text: 'Let me look that up.'},
      {functionCall: {name: 'get_weather', args: {city: 'SF'}}},
      {functionCall: {name: 'get_time', args: {city: 'SF'}}},
    ]);

    expect(functionCallNames(result)).toEqual(['get_weather', 'get_time']);
  });

  it('stops collecting at the first part after the function call group', () => {
    const result = process([
      {functionCall: {name: 'get_weather', args: {city: 'SF'}}},
      {functionCall: {name: 'get_time', args: {city: 'SF'}}},
      {text: 'Trailing commentary.'},
      {functionCall: {name: 'get_news', args: {city: 'SF'}}},
    ]);

    expect(functionCallNames(result)).toEqual(['get_weather', 'get_time']);
  });

  it('drops a leading function call with an empty name and keeps walking', () => {
    const result = process([
      {functionCall: {name: '', args: {}}},
      {text: '/*PLANNING*/Plan it.'},
      {functionCall: {name: 'lookup', args: {q: 'test'}}},
    ]);

    expect(result).toEqual([
      {text: 'Plan it.', thought: true},
      {functionCall: {name: 'lookup', args: {q: 'test'}}},
    ]);
  });
});
