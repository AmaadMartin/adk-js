/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalConstants} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** One expected tool call, as it appears in a `*.test.json` dataset. */
interface ExpectedToolUse {
  tool_name: string;
  tool_input: Record<string, string>;
  mock_tool_output: string;
}

/** One dataset entry, as it appears in a `*.test.json` dataset. */
interface DatasetEntry {
  query: string;
  expected_tool_use: ExpectedToolUse[];
  response: string;
  reference: string;
}

/** Mirrors adk-python's `home_automation_agent` fixture entry. */
const ENTRY: DatasetEntry = {
  query: 'Turn off device_2 in the Bedroom.',
  expected_tool_use: [
    {
      tool_name: 'set_device_info',
      tool_input: {location: 'Bedroom', device_id: 'device_2', status: 'OFF'},
      mock_tool_output: 'Successfully set device_2 status to OFF.',
    },
  ],
  response: "OK. I've turned off device_2 in the Bedroom. Anything else?\n",
  reference: "OK. I've turned off device_2 in the Bedroom. Anything else?\n",
};

describe('EvalConstants', () => {
  it('maps every member to its adk-python string value', () => {
    expect({...EvalConstants}).toEqual({
      QUERY: 'query',
      EXPECTED_TOOL_USE: 'expected_tool_use',
      RESPONSE: 'response',
      REFERENCE: 'reference',
      TOOL_NAME: 'tool_name',
      TOOL_INPUT: 'tool_input',
      MOCK_TOOL_OUTPUT: 'mock_tool_output',
    });
  });

  it('declares exactly seven members, in adk-python order', () => {
    expect(Object.keys(EvalConstants)).toEqual([
      'QUERY',
      'EXPECTED_TOOL_USE',
      'RESPONSE',
      'REFERENCE',
      'TOOL_NAME',
      'TOOL_INPUT',
      'MOCK_TOOL_OUTPUT',
    ]);
  });

  it('reads a dataset entry through the members as index keys', () => {
    expect(ENTRY[EvalConstants.QUERY]).toBe(
      'Turn off device_2 in the Bedroom.',
    );
    expect(ENTRY[EvalConstants.RESPONSE]).toBe(
      "OK. I've turned off device_2 in the Bedroom. Anything else?\n",
    );
    expect(ENTRY[EvalConstants.REFERENCE]).toBe(
      "OK. I've turned off device_2 in the Bedroom. Anything else?\n",
    );

    const toolUse = ENTRY[EvalConstants.EXPECTED_TOOL_USE][0];
    expect(toolUse[EvalConstants.TOOL_NAME]).toBe('set_device_info');
    expect(toolUse[EvalConstants.TOOL_INPUT]).toEqual({
      location: 'Bedroom',
      device_id: 'device_2',
      status: 'OFF',
    });
    expect(toolUse[EvalConstants.MOCK_TOOL_OUTPUT]).toBe(
      'Successfully set device_2 status to OFF.',
    );
  });
});
