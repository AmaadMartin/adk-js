/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ACTION_TAG,
  Context,
  FINAL_ANSWER_TAG,
  InvocationContext,
  LlmRequest,
  PLANNING_TAG,
  PlanReActPlanner,
  PluginManager,
  REASONING_TAG,
  REPLANNING_TAG,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {stripPlanningTags} from '../../src/planners/plan_re_act_planner.js';

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({id: 'session-1', appName: 'app'}),
    pluginManager: new PluginManager([]),
  });
}

function createContext(): Context {
  return new Context({invocationContext: createInvocationContext()});
}

function functionCallNames(parts: Part[]): Array<string | undefined> {
  return parts.flatMap((part) =>
    part.functionCall ? [part.functionCall.name] : [],
  );
}

function process(responseParts: Part[]): Part[] | undefined {
  return new PlanReActPlanner().processPlanningResponse({
    context: createContext(),
    responseParts,
  });
}

/** Runs the planner and narrows away the empty-input `undefined` result. */
function processParts(responseParts: Part[]): Part[] {
  const result = process(responseParts);
  if (result === undefined) {
    expect.fail('processPlanningResponse returned undefined');
  }
  return result;
}

describe('PlanReActPlanner.processPlanningResponse', () => {
  it('strips planning tags and preserves part metadata', () => {
    const result = processParts([
      {text: `${PLANNING_TAG}Step 1: look it up.`, thoughtSignature: 'sig1'},
      {
        text: `${REASONING_TAG}I need to call the tool.`,
        thoughtSignature: 'sig2',
      },
      {functionCall: {name: 'lookup', args: {q: 'test'}}},
    ]);

    const textParts = result.filter((part) => part.text);
    expect(textParts).toHaveLength(2);
    for (const part of textParts) {
      expect(part.text).not.toContain(PLANNING_TAG);
      expect(part.text).not.toContain(REASONING_TAG);
      expect(part.thought).toBe(true);
    }
    expect(textParts[0].thoughtSignature).toBe('sig1');
    expect(textParts[1].thoughtSignature).toBe('sig2');
    expect(functionCallNames(result)).toEqual(['lookup']);
  });

  it('removes the final answer tag from both sides of the split', () => {
    const result = processParts([
      {
        text: `${REASONING_TAG}Some reasoning.${FINAL_ANSWER_TAG}The answer is 42.`,
      },
    ]);

    const combined = result.map((part) => part.text).join(' ');
    expect(combined).not.toContain(FINAL_ANSWER_TAG);
    expect(combined).not.toContain(REASONING_TAG);
    expect(combined).toContain('The answer is 42.');
    expect(result[0].thought).toBe(true);
    expect(result[1].thought).toBeUndefined();
  });

  it('strips multiple embedded planning tags', () => {
    const result = processParts([
      {
        text:
          `${PLANNING_TAG}Initial plan.\n` +
          `${REASONING_TAG}Some reasoning.\n` +
          `${FINAL_ANSWER_TAG}The answer is 42.`,
      },
    ]);

    const combined = result.map((part) => part.text).join(' ');
    expect(combined).not.toContain(PLANNING_TAG);
    expect(combined).not.toContain(REASONING_TAG);
    expect(combined).not.toContain(FINAL_ANSWER_TAG);
    expect(combined).toContain('Initial plan.');
    expect(combined).toContain('Some reasoning.');
    expect(combined).toContain('The answer is 42.');
  });

  it('leaves a part without a leading tag untouched', () => {
    const result = processParts([
      {text: `Here is the answer ${PLANNING_TAG} with stray tag.`},
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].thought).not.toBe(true);
    expect(result[0].text).toBe(
      `Here is the answer ${PLANNING_TAG} with stray tag.`,
    );
  });

  it('keeps a bare tag part next to a function call', () => {
    const result = processParts([
      {text: ACTION_TAG},
      {functionCall: {name: 'lookup', args: {q: 'test'}}},
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('');
    expect(result[0].thought).toBe(true);
    expect(functionCallNames(result)).toEqual(['lookup']);
  });

  it('keeps a sole bare tag part', () => {
    const result = processParts([{text: ACTION_TAG}]);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('');
    expect(result[0].thought).toBe(true);
  });

  it('preserves all leading parallel function calls', () => {
    const result = processParts([
      {functionCall: {name: 'get_weather', args: {city: 'SF'}}},
      {functionCall: {name: 'get_time', args: {city: 'SF'}}},
    ]);

    expect(functionCallNames(result)).toEqual(['get_weather', 'get_time']);
  });

  it('preserves parallel function calls after leading text', () => {
    const result = processParts([
      {text: 'Let me look that up.'},
      {functionCall: {name: 'get_weather', args: {city: 'SF'}}},
      {functionCall: {name: 'get_time', args: {city: 'SF'}}},
    ]);

    expect(functionCallNames(result)).toEqual(['get_weather', 'get_time']);
  });

  it('returns undefined for an empty response', () => {
    expect(process([])).toBeUndefined();
  });

  it('skips an empty-named function call during the leading scan', () => {
    const result = processParts([
      {functionCall: {args: {q: 'test'}}},
      {functionCall: {name: '', args: {q: 'test'}}},
      {functionCall: {name: 'lookup', args: {q: 'test'}}},
    ]);

    expect(functionCallNames(result)).toEqual(['lookup']);
  });

  it('keeps an empty-named function call inside the trailing group', () => {
    const result = processParts([
      {functionCall: {name: 'lookup', args: {q: 'test'}}},
      {functionCall: {name: '', args: {q: 'test'}}},
    ]);

    expect(functionCallNames(result)).toEqual(['lookup', '']);
  });

  it('drops parts after the function call group', () => {
    const result = processParts([
      {functionCall: {name: 'lookup', args: {q: 'test'}}},
      {text: 'Trailing commentary.'},
      {functionCall: {name: 'dropped', args: {}}},
    ]);

    expect(result).toHaveLength(1);
    expect(functionCallNames(result)).toEqual(['lookup']);
  });

  it('drops a part that holds only the final answer tag', () => {
    expect(processParts([{text: FINAL_ANSWER_TAG}])).toEqual([]);
  });

  it('returns only a thought part when nothing follows the final answer tag', () => {
    const result = processParts([
      {text: `${PLANNING_TAG}plan${FINAL_ANSWER_TAG}`},
    ]);

    expect(result).toEqual([{text: 'plan', thought: true}]);
  });

  it('splits on the last final answer tag', () => {
    const result = processParts([
      {text: `a${FINAL_ANSWER_TAG}b${FINAL_ANSWER_TAG}c`},
    ]);

    expect(result).toEqual([
      {text: `a${FINAL_ANSWER_TAG}b`, thought: true},
      {text: 'c'},
    ]);
  });

  it('passes through a part with neither text nor function call', () => {
    const part: Part = {
      inlineData: {mimeType: 'image/png', data: 'Zm9v'},
    };

    const result = processParts([part]);

    expect(result).toEqual([part]);
    expect(result[0].thought).toBeUndefined();
  });

  it('marks a replanning part as a thought', () => {
    const result = processParts([{text: `${REPLANNING_TAG}Revised plan.`}]);

    expect(result).toEqual([{text: 'Revised plan.', thought: true}]);
  });
});

describe('PlanReActPlanner.buildPlanningInstruction', () => {
  const llmRequest: LlmRequest = {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
  };

  it('returns the same instruction on every call', () => {
    const planner = new PlanReActPlanner();
    const readonlyContext = new ReadonlyContext(createInvocationContext());

    const first = planner.buildPlanningInstruction({
      readonlyContext,
      llmRequest,
    });
    const second = planner.buildPlanningInstruction({
      readonlyContext,
      llmRequest,
    });

    expect(first).toBe(second);
    for (const tag of [
      PLANNING_TAG,
      REPLANNING_TAG,
      REASONING_TAG,
      ACTION_TAG,
      FINAL_ANSWER_TAG,
    ]) {
      expect(first).toContain(tag);
    }
    expect(first).toContain('Below are the requirements for the planning:');
    expect(first).toContain('Below are the requirements for the reasoning:');
    expect(first).toContain('Below are the requirements for the final answer:');
    expect(first).toContain('Below are the requirements for the tool code:');
    expect(first).toContain('VERY IMPORTANT instruction');
  });
});

describe('stripPlanningTags', () => {
  it('removes every planning tag but keeps the final answer tag', () => {
    const text = `${PLANNING_TAG}a${REASONING_TAG}b${ACTION_TAG}c${REPLANNING_TAG}d${FINAL_ANSWER_TAG}`;

    expect(stripPlanningTags(text)).toBe(`abcd${FINAL_ANSWER_TAG}`);
  });

  it('does not expand dollar patterns in the surrounding text', () => {
    expect(stripPlanningTags(`${PLANNING_TAG}$&$'$\`$1`)).toBe(`$&$'$\`$1`);
  });
});
