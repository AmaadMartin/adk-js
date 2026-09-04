/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The two accessors this branch adds to `llm_as_judge_utils.ts`, which
 * `google/adk-python` keeps in `llm_as_judge_utils.py` and on its `AppDetails`
 * model.
 */

import {
  formatPromptTemplate,
  getToolDeclarationsAsJsonStr,
  type AppDetails,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('formatPromptTemplate', () => {
  it('fills every named placeholder', () => {
    expect(formatPromptTemplate('a {one} b {two}', {one: '1', two: '2'})).toBe(
      'a 1 b 2',
    );
  });

  it('scans the template once, so a value naming a placeholder is inert', () => {
    expect(
      formatPromptTemplate('{first}|{second}', {
        first: 'holds {second}',
        second: 'REAL',
      }),
    ).toBe('holds {second}|REAL');
  });

  it('leaves a placeholder the values do not cover in place', () => {
    expect(formatPromptTemplate('{known} {unknown}', {known: 'x'})).toBe(
      'x {unknown}',
    );
  });

  it('unescapes a doubled brace', () => {
    expect(formatPromptTemplate('{{ {name} }}', {name: 'x'})).toBe('{ x }');
  });

  it('passes a value containing a replacement pattern through unchanged', () => {
    expect(formatPromptTemplate('{name}', {name: '$& and $1'})).toBe(
      '$& and $1',
    );
  });
});

describe('getToolDeclarationsAsJsonStr', () => {
  it('keys the declarations by agent name, in snake_case', () => {
    const appDetails: AppDetails = {
      agentDetails: {
        root: {
          name: 'root',
          toolDeclarations: [{functionDeclarations: [{name: 'tool1'}]}],
        },
        helper: {name: 'helper', toolDeclarations: []},
      },
    };

    expect(getToolDeclarationsAsJsonStr(appDetails)).toBe(
      `{
  "tool_declarations": {
    "root": [
      {
        "function_declarations": [
          {
            "name": "tool1"
          }
        ]
      }
    ],
    "helper": []
  }
}`,
    );
  });

  it('reports an empty map when the app declares no agent', () => {
    expect(getToolDeclarationsAsJsonStr({})).toBe(
      '{\n  "tool_declarations": {}\n}',
    );
  });
});
