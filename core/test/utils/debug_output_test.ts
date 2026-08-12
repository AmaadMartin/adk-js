/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '@google/adk';
import {Language, Part} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {formatEventLines, printEvent} from '../../src/utils/debug_output.js';
import {logger} from '../../src/utils/logger.js';

const AUTHOR = 'test_agent';
const VERBOSE = {verbose: true};

function eventWithParts(parts: Part[]): Event {
  return createEvent({author: AUTHOR, content: {role: 'model', parts}});
}

function renderVerbose(part: Part): string[] {
  return formatEventLines(eventWithParts([part]), VERBOSE);
}

describe('formatEventLines', () => {
  it('renders nothing for an event without content', () => {
    expect(formatEventLines(createEvent({author: AUTHOR}))).toEqual([]);
  });

  it('renders nothing for an event with no parts', () => {
    expect(formatEventLines(eventWithParts([]))).toEqual([]);
  });

  it('renders a text part as a single authored line', () => {
    expect(formatEventLines(eventWithParts([{text: 'Hello'}]))).toEqual([
      `${AUTHOR} > Hello`,
    ]);
  });

  it('renders an empty author prefix when the event has no author', () => {
    const event = createEvent({
      content: {role: 'model', parts: [{text: 'Hi'}]},
    });

    expect(formatEventLines(event)).toEqual([' > Hi']);
  });

  it('joins consecutive text parts into one line', () => {
    const lines = formatEventLines(
      eventWithParts([{text: 'Hello '}, {text: 'world'}]),
    );

    expect(lines).toEqual([`${AUTHOR} > Hello world`]);
  });

  it('contributes no line for a text part that is the empty string', () => {
    const lines = formatEventLines(
      eventWithParts([{text: ''}, {text: 'kept'}]),
    );

    expect(lines).toEqual([`${AUTHOR} > kept`]);
  });

  it('omits non-text parts but keeps the text line when not verbose', () => {
    const lines = formatEventLines(
      eventWithParts([
        {text: 'Working'},
        {functionCall: {name: 'calculate', args: {expression: '1 + 1'}}},
        {functionResponse: {name: 'calculate', response: {result: 2}}},
      ]),
    );

    expect(lines).toEqual([`${AUTHOR} > Working`]);
  });

  it('renders a function call when verbose', () => {
    const part: Part = {
      functionCall: {name: 'calculate', args: {expression: '42 * 3.14'}},
    };

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [Calling tool: calculate({"expression":"42 * 3.14"})]`,
    ]);
  });

  it('renders empty arguments for a function call without args', () => {
    expect(renderVerbose({functionCall: {name: 'ping'}})).toEqual([
      `${AUTHOR} > [Calling tool: ping({})]`,
    ]);
  });

  it('renders a function response when verbose', () => {
    const part: Part = {
      functionResponse: {name: 'calculate', response: {result: 131.88}},
    };

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [Tool result: {"result":131.88}]`,
    ]);
  });

  it('renders an empty function response without a response', () => {
    expect(renderVerbose({functionResponse: {name: 'calculate'}})).toEqual([
      `${AUTHOR} > [Tool result: {}]`,
    ]);
  });

  it('renders executable code with its language when verbose', () => {
    const part: Part = {
      executableCode: {code: 'print(1)', language: Language.PYTHON},
    };

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [Executing PYTHON code...]`,
    ]);
  });

  it('falls back to "code" when executable code has no language', () => {
    expect(renderVerbose({executableCode: {code: 'print(1)'}})).toEqual([
      `${AUTHOR} > [Executing code code...]`,
    ]);
  });

  it('renders code execution output when verbose', () => {
    expect(renderVerbose({codeExecutionResult: {output: '42'}})).toEqual([
      `${AUTHOR} > [Code output: 42]`,
    ]);
  });

  it('falls back to "result" when the code execution has no output', () => {
    expect(renderVerbose({codeExecutionResult: {}})).toEqual([
      `${AUTHOR} > [Code output: result]`,
    ]);
  });

  it('renders inline data by mime type when verbose', () => {
    const part: Part = {inlineData: {mimeType: 'image/png', data: 'AAA='}};

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [Inline data: image/png]`,
    ]);
  });

  it('falls back to "data" when inline data has no mime type', () => {
    expect(renderVerbose({inlineData: {data: 'AAA='}})).toEqual([
      `${AUTHOR} > [Inline data: data]`,
    ]);
  });

  it('renders file data by uri when verbose', () => {
    const part: Part = {fileData: {fileUri: 'gs://bucket/f.png'}};

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [File: gs://bucket/f.png]`,
    ]);
  });

  it('falls back to "file" when file data has no uri', () => {
    expect(renderVerbose({fileData: {mimeType: 'image/png'}})).toEqual([
      `${AUTHOR} > [File: file]`,
    ]);
  });

  it('renders nothing for a non-text part it does not recognise', () => {
    expect(renderVerbose({thought: true})).toEqual([]);
  });

  it('truncates function call arguments longer than 50 characters', () => {
    const part: Part = {
      functionCall: {name: 'big', args: {value: 'x'.repeat(100)}},
    };

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [Calling tool: big({"value":"${'x'.repeat(40)}...)]`,
    ]);
  });

  it('leaves function call arguments of exactly 50 characters intact', () => {
    const value = 'x'.repeat(42);
    const part: Part = {functionCall: {name: 'big', args: {v: value}}};

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [Calling tool: big({"v":"${value}"})]`,
    ]);
  });

  it('truncates a function response longer than 100 characters', () => {
    const part: Part = {
      functionResponse: {name: 'big', response: {data: 'y'.repeat(200)}},
    };

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [Tool result: {"data":"${'y'.repeat(91)}...]`,
    ]);
  });

  it('truncates code execution output longer than 100 characters', () => {
    const part: Part = {codeExecutionResult: {output: 'z'.repeat(150)}};

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [Code output: ${'z'.repeat(100)}...]`,
    ]);
  });

  it('leaves code execution output of exactly 100 characters intact', () => {
    const output = 'z'.repeat(100);

    expect(renderVerbose({codeExecutionResult: {output}})).toEqual([
      `${AUTHOR} > [Code output: ${output}]`,
    ]);
  });

  it('flushes buffered text before a non-text part and keeps the order', () => {
    const lines = formatEventLines(
      eventWithParts([
        {text: 'Running'},
        {executableCode: {code: 'print(1)', language: Language.PYTHON}},
        {codeExecutionResult: {output: '1'}},
      ]),
      VERBOSE,
    );

    expect(lines).toEqual([
      `${AUTHOR} > Running`,
      `${AUTHOR} > [Executing PYTHON code...]`,
      `${AUTHOR} > [Code output: 1]`,
    ]);
  });

  it('prefers the function call over other fields on the same part', () => {
    const part: Part = {
      functionCall: {name: 'calculate', args: {}},
      functionResponse: {name: 'calculate', response: {result: 2}},
      fileData: {fileUri: 'gs://bucket/f.png'},
    };

    expect(renderVerbose(part)).toEqual([
      `${AUTHOR} > [Calling tool: calculate({})]`,
    ]);
  });
});

describe('printEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs one line per rendered line', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

    printEvent(
      eventWithParts([
        {text: 'Hello'},
        {functionCall: {name: 'calculate', args: {}}},
      ]),
      VERBOSE,
    );

    expect(info.mock.calls).toEqual([
      [`${AUTHOR} > Hello`],
      [`${AUTHOR} > [Calling tool: calculate({})]`],
    ]);
  });

  it('logs nothing for an event that renders to nothing', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

    printEvent(createEvent({author: AUTHOR}));

    expect(info).not.toHaveBeenCalled();
  });
});
