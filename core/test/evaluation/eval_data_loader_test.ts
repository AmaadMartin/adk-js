/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalConfig,
  EvalConfigSchema,
  EvalSetSchema,
  loadEvalSetFromFile,
  toEvalSetJson,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

// Package-internal: these are not on the public barrel, so they are imported
// by module path, as the sibling evaluation tests do.
import {
  convertLegacyEvalSet,
  LegacyInvocationSchema,
  validateLegacyInput,
} from '../../src/evaluation/eval_data_loader.js';

const DEFAULT_CONFIG: EvalConfig = EvalConfigSchema.parse({
  criteria: {tool_trajectory_avg_score: 1.0, response_match_score: 0.8},
});

const SNAKE_CASE_EVAL_SET = {
  eval_set_id: 'dice_set',
  name: 'dice_set',
  creation_timestamp: 1,
  eval_cases: [
    {
      eval_id: 'roll_a_die',
      conversation: [
        {
          invocation_id: 'inv-1',
          user_content: {role: 'user', parts: [{text: 'Roll a 17 sided dice'}]},
          final_response: {role: 'model', parts: [{text: 'I rolled 13.'}]},
          intermediate_data: {
            tool_uses: [{name: 'roll_die', args: {sides_count: 17}}],
            tool_responses: [],
            intermediate_responses: [],
          },
          creation_timestamp: 1,
        },
      ],
      session_input: {
        app_name: 'dice',
        user_id: 'u',
        state: {user_name: 'Ada'},
      },
      creation_timestamp: 1,
    },
  ],
};

const CAMEL_CASE_EVAL_SET = {
  evalSetId: 'dice_set',
  name: 'dice_set',
  creationTimestamp: 1,
  evalCases: [
    {
      evalId: 'roll_a_die',
      conversation: [
        {
          invocationId: 'inv-1',
          userContent: {role: 'user', parts: [{text: 'Roll a 17 sided dice'}]},
          finalResponse: {role: 'model', parts: [{text: 'I rolled 13.'}]},
          intermediateData: {
            toolUses: [{name: 'roll_die', args: {sides_count: 17}}],
            toolResponses: [],
            intermediateResponses: [],
          },
          creationTimestamp: 1,
        },
      ],
      creationTimestamp: 1,
    },
  ],
};

const LEGACY_EVAL_FILE = [
  {
    query: 'Roll a 17 sided dice',
    expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides_count: 17}}],
    expected_intermediate_agent_responses: [
      {author: 'dice_agent', text: 'Rolling now.'},
    ],
    reference: 'I rolled 13.\n',
  },
];

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-eval-loader-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf-8');
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('loadEvalSetFromFile', () => {
  it('reads an eval set written with snake_case keys', () => {
    const file = writeJson(makeTempDir(), 'a.test.json', SNAKE_CASE_EVAL_SET);

    const evalSet = loadEvalSetFromFile(file, DEFAULT_CONFIG, {});

    expect(evalSet.evalSetId).toBe('dice_set');
    expect(evalSet.evalCases[0].evalId).toBe('roll_a_die');
    expect(evalSet.evalCases[0].conversation?.[0].invocationId).toBe('inv-1');
  });

  it('reads the same eval set written with camelCase keys', () => {
    const file = writeJson(makeTempDir(), 'a.test.json', CAMEL_CASE_EVAL_SET);

    const evalSet = loadEvalSetFromFile(file, DEFAULT_CONFIG, {});

    expect(evalSet.evalSetId).toBe('dice_set');
    expect(evalSet.evalCases[0].conversation?.[0].invocationId).toBe('inv-1');
    expect(
      evalSet.evalCases[0].conversation?.[0].intermediateData,
    ).toMatchObject({toolUses: [{name: 'roll_die', args: {sides_count: 17}}]});
  });

  it('keeps user-defined keys in tool args and session state verbatim', () => {
    const file = writeJson(makeTempDir(), 'a.test.json', SNAKE_CASE_EVAL_SET);

    const evalSet = loadEvalSetFromFile(file, DEFAULT_CONFIG, {});

    const intermediateData =
      evalSet.evalCases[0].conversation?.[0].intermediateData;
    expect(intermediateData).toMatchObject({
      toolUses: [{name: 'roll_die', args: {sides_count: 17}}],
    });
    expect(evalSet.evalCases[0].sessionInput?.state).toEqual({
      user_name: 'Ada',
    });
  });

  it('reads an eval set that spells unset optional fields as null', () => {
    // adk-python serializes every unset optional field as null.
    const file = writeJson(makeTempDir(), 'a.test.json', {
      eval_set_id: 'dice_set',
      name: 'dice_set',
      description: null,
      creation_timestamp: 1,
      eval_cases: [
        {
          eval_id: 'roll_a_die',
          session_input: null,
          rubrics: null,
          conversation: [
            {
              invocation_id: 'inv-1',
              user_content: {
                parts: [{function_call: null, text: 'Roll a 17 sided dice'}],
                role: 'user',
              },
              final_response: {parts: [{text: 'I rolled 13.'}], role: 'model'},
              intermediate_data: {
                tool_uses: [
                  {id: null, name: 'roll_die', args: {sides_count: null}},
                ],
                intermediate_responses: [],
              },
              creation_timestamp: 1,
            },
          ],
          creation_timestamp: 1,
        },
      ],
    });

    const evalSet = loadEvalSetFromFile(file, DEFAULT_CONFIG, {});

    expect(evalSet.evalCases[0].sessionInput).toBeUndefined();
    expect(evalSet.evalCases[0].conversation?.[0].userContent).toEqual({
      parts: [{text: 'Roll a 17 sided dice'}],
      role: 'user',
    });
    // A null inside a user-defined map is data, not an omission.
    expect(
      evalSet.evalCases[0].conversation?.[0].intermediateData,
    ).toMatchObject({
      toolUses: [{name: 'roll_die', args: {sides_count: null}}],
    });
  });

  it('rejects an eval set file combined with an initial session', () => {
    const file = writeJson(makeTempDir(), 'a.test.json', SNAKE_CASE_EVAL_SET);

    expect(() =>
      loadEvalSetFromFile(file, DEFAULT_CONFIG, {app_name: 'dice'}),
    ).toThrow(/Initial session should be specified as a part of the EvalSet/);
  });

  it('falls back to the legacy format and converts it', () => {
    const file = writeJson(makeTempDir(), 'a.test.json', LEGACY_EVAL_FILE);

    const evalSet = loadEvalSetFromFile(file, DEFAULT_CONFIG, {});

    expect(evalSet.evalCases).toHaveLength(1);
    expect(evalSet.evalCases[0].evalId).toBe(file);
    const invocation = evalSet.evalCases[0].conversation?.[0];
    expect(invocation?.userContent).toEqual({
      role: 'user',
      parts: [{text: 'Roll a 17 sided dice'}],
    });
    expect(invocation?.finalResponse).toEqual({
      role: 'model',
      parts: [{text: 'I rolled 13.\n'}],
    });
    expect(invocation?.intermediateData).toEqual({
      toolUses: [{name: 'roll_die', args: {sides_count: 17}}],
      toolResponses: [],
      intermediateResponses: [['dice_agent', [{text: 'Rolling now.'}]]],
    });
    expect(invocation?.invocationId).not.toBe('');
  });

  it('applies the initial session to a legacy file', () => {
    const file = writeJson(makeTempDir(), 'a.test.json', LEGACY_EVAL_FILE);

    const evalSet = loadEvalSetFromFile(file, DEFAULT_CONFIG, {
      app_name: 'dice',
      user_id: 'u',
      state: {user_name: 'Ada'},
    });

    expect(evalSet.evalCases[0].sessionInput).toEqual({
      appName: 'dice',
      userId: 'u',
      state: {user_name: 'Ada'},
    });
  });

  it('leaves the session input unset when no initial session is given', () => {
    const file = writeJson(makeTempDir(), 'a.test.json', LEGACY_EVAL_FILE);

    const evalSet = loadEvalSetFromFile(file, DEFAULT_CONFIG, {});

    expect(evalSet.evalCases[0].sessionInput).toBeUndefined();
  });

  it('rejects a path that is not a file', () => {
    const dir = makeTempDir();

    expect(() => loadEvalSetFromFile(dir, DEFAULT_CONFIG, {})).toThrow(
      `Input path ${dir} is invalid.`,
    );
  });

  it('rejects a path that does not exist', () => {
    const missing = path.join(makeTempDir(), 'missing.test.json');

    expect(() => loadEvalSetFromFile(missing, DEFAULT_CONFIG, {})).toThrow(
      `Input path ${missing} is invalid.`,
    );
  });

  it('surfaces a JSON syntax error', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'a.test.json');
    fs.writeFileSync(file, '{not json', 'utf-8');

    expect(() => loadEvalSetFromFile(file, DEFAULT_CONFIG, {})).toThrow(
      SyntaxError,
    );
  });
});

describe('validateLegacyInput', () => {
  it('rejects a criteria key that is not allowed', () => {
    expect(() =>
      validateLegacyInput(LEGACY_EVAL_FILE, {made_up_metric: 1}),
    ).toThrow(/Invalid criteria key: made_up_metric/);
  });

  it('rejects an empty dataset', () => {
    expect(() => validateLegacyInput([], {})).toThrow(
      'The evaluation dataset is None or empty.',
    );
  });

  it('rejects a dataset that is not an array', () => {
    expect(() => validateLegacyInput({query: 'hi'}, {})).toThrow(
      'The evaluation dataset is None or empty.',
    );
  });

  it('rejects a dataset whose first row is not an object', () => {
    expect(() => validateLegacyInput(['hi'], {})).toThrow(
      /must be a list of objects/,
    );
  });

  it('requires query and expected_tool_use for the trajectory metric', () => {
    expect(() =>
      validateLegacyInput([{query: 'hi'}], {tool_trajectory_avg_score: 1}),
    ).toThrow(/tool_trajectory_avg_score must include query and/);
  });

  it('requires query for the response evaluation metric', () => {
    expect(() =>
      validateLegacyInput([{reference: 'hi'}], {
        response_evaluation_score: 1,
      }),
    ).toThrow(/response_evaluation_score must include query keys/);
  });

  it('requires query and reference for the response match metric', () => {
    expect(() =>
      validateLegacyInput([{query: 'hi'}], {response_match_score: 0.8}),
    ).toThrow(/response_match_score must include query and reference keys/);
  });

  it('accepts a dataset that satisfies every configured metric', () => {
    expect(() =>
      validateLegacyInput(LEGACY_EVAL_FILE, DEFAULT_CONFIG.criteria),
    ).not.toThrow();
  });
});

describe('convertLegacyEvalSet', () => {
  it('defaults optional legacy fields', () => {
    const evalSet = convertLegacyEvalSet('set-1', [
      {name: 'case-1', data: [LegacyInvocationSchema.parse({query: 'hi'})]},
    ]);

    const invocation = evalSet.evalCases[0].conversation?.[0];
    expect(invocation?.finalResponse).toEqual({
      role: 'model',
      parts: [{text: ''}],
    });
    expect(invocation?.intermediateData).toEqual({
      toolUses: [],
      toolResponses: [],
      intermediateResponses: [],
    });
  });
});

describe('toEvalSetJson', () => {
  it('writes snake_case keys and preserves user-defined keys', () => {
    const file = writeJson(makeTempDir(), 'a.test.json', LEGACY_EVAL_FILE);
    const evalSet = loadEvalSetFromFile(file, DEFAULT_CONFIG, {
      app_name: 'dice',
      user_id: 'u',
      state: {user_name: 'Ada'},
    });

    const written = JSON.parse(toEvalSetJson(evalSet)) as Record<
      string,
      unknown
    >;

    expect(Object.keys(written)).toContain('eval_set_id');
    expect(written).toMatchObject({
      eval_cases: [
        {
          session_input: {app_name: 'dice', state: {user_name: 'Ada'}},
          conversation: [
            {
              intermediate_data: {
                tool_uses: [{name: 'roll_die', args: {sides_count: 17}}],
              },
            },
          ],
        },
      ],
    });
  });

  it('indents with two spaces', () => {
    const evalSet = EvalSetSchema.parse({evalSetId: 'set-1', evalCases: []});

    expect(toEvalSetJson(evalSet)).toContain('\n  "eval_set_id": "set-1"');
  });
});
