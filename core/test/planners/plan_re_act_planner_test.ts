/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ACTION_TAG,
  BaseAgent,
  Context,
  createSession,
  FINAL_ANSWER_TAG,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PLANNING_TAG,
  PlanReActPlanner,
  PluginManager,
  ReadonlyContext,
  REASONING_TAG,
  REPLANNING_TAG,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createInvocationContext(): InvocationContext {
  const agent: BaseAgent = new LlmAgent({name: 'test_agent'});
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createContext(): Context {
  return new Context({invocationContext: createInvocationContext()});
}

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

function functionCallPart(name: string): Part {
  return {functionCall: {name, args: {city: 'SF'}}};
}

function functionCallNames(parts: Part[]): Array<string | undefined> {
  return parts
    .filter((part) => part.functionCall)
    .map((part) => part.functionCall?.name);
}

function process(responseParts: Part[]): Part[] | undefined {
  return new PlanReActPlanner().processPlanningResponse(
    createContext(),
    responseParts,
  );
}

function requireParts(parts: Part[] | undefined): Part[] {
  if (!parts) {
    expect.fail('the planner returned no parts');
  }
  return parts;
}

describe('PlanReActPlanner.buildPlanningInstruction', () => {
  it('names every tag the model must use', () => {
    const planner = new PlanReActPlanner();
    const invocationContext = createInvocationContext();

    const instruction = planner.buildPlanningInstruction(
      new ReadonlyContext(invocationContext),
      createLlmRequest(),
    );

    expect(instruction).toContain(PLANNING_TAG);
    expect(instruction).toContain(REPLANNING_TAG);
    expect(instruction).toContain(REASONING_TAG);
    expect(instruction).toContain(ACTION_TAG);
    expect(instruction).toContain(FINAL_ANSWER_TAG);
  });

  it('joins the six preamble blocks with a blank line', () => {
    const instruction = new PlanReActPlanner().buildPlanningInstruction(
      new ReadonlyContext(createInvocationContext()),
      createLlmRequest(),
    );

    expect(instruction.split('\n\n\n\n')).toHaveLength(6);
    expect(instruction.startsWith('\nWhen answering the question,')).toBe(true);
    expect(
      instruction.endsWith(
        'You should prefer using the information available in the context instead of repeated tool use.\n',
      ),
    ).toBe(true);
  });
});

describe('PlanReActPlanner.processPlanningResponse', () => {
  it('strips the planning tags and keeps the part metadata', () => {
    const result = requireParts(
      process([
        {text: `${PLANNING_TAG}Step 1: look it up.`, thoughtSignature: 'sig1'},
        {
          text: `${REASONING_TAG}I need to call the tool.`,
          thoughtSignature: 'sig2',
        },
        functionCallPart('lookup'),
      ]),
    );

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

  it('strips the final answer tag at the boundary', () => {
    const result = requireParts(
      process([
        {
          text: `${REASONING_TAG}Some reasoning.${FINAL_ANSWER_TAG}The answer is 42.`,
        },
      ]),
    );

    const combined = result.map((part) => part.text).join(' ');
    expect(combined).not.toContain(FINAL_ANSWER_TAG);
    expect(combined).not.toContain(REASONING_TAG);
    expect(combined).toContain('The answer is 42.');
    expect(result[0].thought).toBe(true);
    expect(result[1].thought).toBeUndefined();
  });

  it('strips several embedded planning tags', () => {
    const result = requireParts(
      process([
        {
          text:
            `${PLANNING_TAG}Initial plan.\n` +
            `${REASONING_TAG}Some reasoning.\n` +
            `${FINAL_ANSWER_TAG}The answer is 42.`,
        },
      ]),
    );

    const combined = result.map((part) => part.text).join(' ');
    expect(combined).not.toContain(PLANNING_TAG);
    expect(combined).not.toContain(REASONING_TAG);
    expect(combined).not.toContain(FINAL_ANSWER_TAG);
    expect(combined).toContain('Initial plan.');
    expect(combined).toContain('Some reasoning.');
    expect(combined).toContain('The answer is 42.');
  });

  it('drops a reasoning block that holds nothing but tags', () => {
    const result = requireParts(
      process([{text: `${PLANNING_TAG}${FINAL_ANSWER_TAG}The answer is 42.`}]),
    );

    expect(result).toEqual([{text: 'The answer is 42.'}]);
  });

  it('keeps a reasoning block whose answer is empty', () => {
    const result = requireParts(
      process([{text: `${REASONING_TAG}Some reasoning.${FINAL_ANSWER_TAG}`}]),
    );

    expect(result).toEqual([{text: 'Some reasoning.', thought: true}]);
  });

  it('leaves a part without a leading tag alone', () => {
    const result = requireParts(
      process([{text: `Here is the answer ${PLANNING_TAG} with stray tag.`}]),
    );

    expect(result).toHaveLength(1);
    expect(result[0].thought).toBeUndefined();
    expect(result[0].text).toBe(
      `Here is the answer ${PLANNING_TAG} with stray tag.`,
    );
  });

  it('keeps a bare tag part as an empty thought', () => {
    const result = requireParts(
      process([{text: ACTION_TAG}, functionCallPart('lookup')]),
    );

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('');
    expect(result[0].thought).toBe(true);
    expect(functionCallNames(result)).toEqual(['lookup']);
  });

  it('keeps a sole bare tag part as an empty thought', () => {
    const result = requireParts(process([{text: ACTION_TAG}]));

    expect(result).toEqual([{text: '', thought: true}]);
  });

  it('preserves every leading parallel function call', () => {
    const result = requireParts(
      process([functionCallPart('get_weather'), functionCallPart('get_time')]),
    );

    expect(functionCallNames(result)).toEqual(['get_weather', 'get_time']);
  });

  it('preserves parallel function calls after leading text', () => {
    const result = requireParts(
      process([
        {text: 'Let me look that up.'},
        functionCallPart('get_weather'),
        functionCallPart('get_time'),
      ]),
    );

    expect(functionCallNames(result)).toEqual(['get_weather', 'get_time']);
  });

  it('stops at the first part that follows the call group', () => {
    const result = requireParts(
      process([
        functionCallPart('get_weather'),
        {text: 'trailing commentary'},
        functionCallPart('get_time'),
      ]),
    );

    expect(result).toHaveLength(1);
    expect(functionCallNames(result)).toEqual(['get_weather']);
  });

  it('drops a function call with no name and keeps scanning', () => {
    const result = requireParts(
      process([{functionCall: {args: {}}}, functionCallPart('get_time')]),
    );

    expect(functionCallNames(result)).toEqual(['get_time']);
  });

  it('keeps a part that carries no text at all', () => {
    const result = requireParts(
      process([{inlineData: {mimeType: 'image/png', data: 'AAAA'}}]),
    );

    expect(result).toHaveLength(1);
    expect(result[0].thought).toBeUndefined();
  });

  it('returns undefined for an empty part list', () => {
    expect(process([])).toBeUndefined();
  });
});
