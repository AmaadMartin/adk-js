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
  PLANNING_TAG,
  PlanReActPlanner,
  PluginManager,
  REASONING_TAG,
  ReadonlyContext,
  createSession,
  type LlmRequest,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

/**
 * Drives the planner over a full model turn. No model runs: the parts below
 * are the shape a Gemini turn produces once the planner instruction is in the
 * request.
 */
describe('PlanReActPlanner over a full model turn', () => {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-plan-re-act',
    session: createSession({id: 'session-1', appName: 'weather-app'}),
    pluginManager: new PluginManager([]),
  });
  const context = new Context({invocationContext});
  const llmRequest: LlmRequest = {
    model: 'gemini-2.0-flash',
    contents: [{role: 'user', parts: [{text: 'Weather and time in SF?'}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };

  it('instructs the model to plan, then reduces its answer to plan and calls', () => {
    const planner = new PlanReActPlanner();

    const instruction = planner.buildPlanningInstruction({
      readonlyContext: new ReadonlyContext(invocationContext),
      llmRequest,
    });
    expect(instruction).toContain(PLANNING_TAG);
    expect(instruction).toContain(ACTION_TAG);

    const modelParts: Part[] = [
      {
        text: `${PLANNING_TAG}1. Get the weather.\n2. Get the time.`,
        thoughtSignature: 'plan-signature',
      },
      {
        text: `${REASONING_TAG}Both tools are independent, so call them together.`,
      },
      {functionCall: {name: 'get_weather', args: {city: 'SF'}}},
      {functionCall: {name: 'get_time', args: {city: 'SF'}}},
      {text: `${FINAL_ANSWER_TAG}It is sunny at 3pm.`},
    ];

    const result = planner.processPlanningResponse({
      context,
      responseParts: modelParts,
    });

    expect(result).toEqual([
      {
        text: '1. Get the weather.\n2. Get the time.',
        thought: true,
        thoughtSignature: 'plan-signature',
      },
      {
        text: 'Both tools are independent, so call them together.',
        thought: true,
      },
      {functionCall: {name: 'get_weather', args: {city: 'SF'}}},
      {functionCall: {name: 'get_time', args: {city: 'SF'}}},
    ]);
  });

  it('returns the answer as ordinary content once the tools have run', () => {
    const planner = new PlanReActPlanner();

    const result = planner.processPlanningResponse({
      context,
      responseParts: [
        {
          text: `${REASONING_TAG}Both tools answered.${FINAL_ANSWER_TAG}It is sunny at 3pm in SF.`,
        },
      ],
    });

    expect(result).toEqual([
      {text: 'Both tools answered.', thought: true},
      {text: 'It is sunny at 3pm in SF.'},
    ]);
  });
});
