/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt-formatting cases the ported adk-python suite leaves open: rubric
 * scoping and ordering, the duplicate-id error, and the placeholder
 * substitution itself.
 */

import {
  EvalMetric,
  InputValidationError,
  Invocation,
  PrebuiltMetrics,
  Rubric,
  RubricBasedToolUseV1Evaluator,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm} from './fake_judge_llm.js';

const PLACEHOLDERS = [
  '{tool_declarations}',
  '{user_input}',
  '{tool_usage}',
  '{rubrics}',
];

function createEvaluator(rubrics: Rubric[]): RubricBasedToolUseV1Evaluator {
  const evalMetric: EvalMetric = {
    metricName: PrebuiltMetrics.RUBRIC_BASED_TOOL_USE_QUALITY_V1,
    threshold: 0.5,
    criterion: {threshold: 0.5, rubrics, judgeModelOptions: {numSamples: 3}},
  };
  return new RubricBasedToolUseV1Evaluator(
    evalMetric,
    new FakeJudgeLlm([{silent: true}]),
  );
}

function createInvocation(partial: Partial<Invocation> = {}): Invocation {
  return {userContent: {parts: [{text: 'User input here.'}]}, ...partial};
}

describe('RubricBasedToolUseV1Evaluator rubric scoping', () => {
  it('names the rubric type it grades', () => {
    expect(RubricBasedToolUseV1Evaluator.RUBRIC_TYPE).toBe('TOOL_USE_QUALITY');
  });

  it('skips an invocation rubric of another type', () => {
    const prompt = createEvaluator([
      {rubricId: '1', rubricContent: {textProperty: 'Was a tool called?'}},
    ]).formatAutoRaterPrompt(
      createInvocation({
        rubrics: [
          {
            rubricId: '2',
            rubricContent: {textProperty: 'Is the answer grounded?'},
            type: 'FINAL_RESPONSE_QUALITY',
          },
        ],
      }),
    );

    expect(prompt).toContain('*  [id: 1] Was a tool called?');
    expect(prompt).not.toContain('Is the answer grounded?');
  });

  it('rejects an invocation whose only rubric is of another type', () => {
    const evaluator = createEvaluator([]);
    const invocation = createInvocation({
      rubrics: [
        {
          rubricId: '2',
          rubricContent: {textProperty: 'Is the answer grounded?'},
          type: 'FINAL_RESPONSE_QUALITY',
        },
      ],
    });

    expect(() => evaluator.formatAutoRaterPrompt(invocation)).toThrow(
      new InputValidationError('Rubrics are required.'),
    );
  });

  it('rejects a criterion rubric and an invocation rubric that share an id', () => {
    const evaluator = createEvaluator([
      {rubricId: 'shared', rubricContent: {textProperty: 'From criterion.'}},
    ]);
    const invocation = createInvocation({
      rubrics: [
        {
          rubricId: 'shared',
          rubricContent: {textProperty: 'From invocation.'},
          type: 'TOOL_USE_QUALITY',
        },
      ],
    });

    expect(() => evaluator.formatAutoRaterPrompt(invocation)).toThrow(
      new InputValidationError(
        "Rubric with rubric_id 'shared' already exists. Rubric defined in" +
          ' invocation conflicts with an existing rubric.',
      ),
    );
  });

  it('lists the criterion rubrics before the invocation rubrics', () => {
    const prompt = createEvaluator([
      {rubricId: 'c1', rubricContent: {textProperty: 'From criterion.'}},
    ]).formatAutoRaterPrompt(
      createInvocation({
        rubrics: [
          {
            rubricId: 'i1',
            rubricContent: {textProperty: 'From invocation.'},
            type: 'TOOL_USE_QUALITY',
          },
        ],
      }),
    );

    expect(prompt).toContain(
      '*  [id: c1] From criterion.\n*  [id: i1] From invocation.',
    );
  });
});

describe('RubricBasedToolUseV1Evaluator prompt substitution', () => {
  it('substitutes every placeholder the template declares', () => {
    const prompt = createEvaluator([
      {rubricId: '1', rubricContent: {textProperty: 'Was a tool called?'}},
    ]).formatAutoRaterPrompt(createInvocation());

    for (const placeholder of PLACEHOLDERS) {
      expect(prompt).not.toContain(placeholder);
    }
  });

  it('puts each value in the section the judge reads it from', () => {
    const prompt = createEvaluator([
      {rubricId: '1', rubricContent: {textProperty: 'Was a tool called?'}},
    ]).formatAutoRaterPrompt(
      createInvocation({
        intermediateData: {
          toolUses: [{name: 'test_func', args: {arg1: 'val1'}, id: 'call1'}],
          toolResponses: [
            {name: 'test_func', response: {result: 'ok'}, id: 'call1'},
          ],
          intermediateResponses: [],
        },
      }),
    );

    expect(prompt).toContain('<user_prompt>\nUser input here.\n</user_prompt>');
    expect(prompt).toMatch(
      /<response>\n\{\n {2}"tool_calls_and_response": \[[\s\S]*?\n\}\n<\/response>/,
    );
    expect(prompt).toContain(
      '<properties>\n*  [id: 1] Was a tool called?\n</properties>',
    );
  });

  it('carries rubric text with replacement patterns through unchanged', () => {
    const textProperty = 'Does the reply keep $& and {user_input} verbatim?';

    const prompt = createEvaluator([
      {rubricId: '1', rubricContent: {textProperty}},
    ]).formatAutoRaterPrompt(createInvocation());

    expect(prompt).toContain(`*  [id: 1] ${textProperty}`);
  });

  it('reports a tool call that got no response', () => {
    const prompt = createEvaluator([
      {rubricId: '1', rubricContent: {textProperty: 'Was a tool called?'}},
    ]).formatAutoRaterPrompt(
      createInvocation({
        intermediateData: {
          toolUses: [{name: 'test_func', args: {arg1: 'val1'}, id: 'call1'}],
          toolResponses: [],
          intermediateResponses: [],
        },
      }),
    );

    expect(prompt).toContain('"tool_response": "None"');
  });
});
