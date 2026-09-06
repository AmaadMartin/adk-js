/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Language, Outcome, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  BaseCodeExecutor,
  ExecuteCodeParams,
} from '../../src/code_executors/base_code_executor.js';
import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  FileContentEncoding,
  buildCodeExecutionResultPart,
  buildExecutableCodePart,
  convertCodeExecutionParts,
  extractCodeAndTruncateContent,
  getEncodedFileContent,
  selectCodeBlockDelimiter,
} from '../../src/code_executors/code_execution_utils.js';
import {base64Encode} from '../../src/utils/env_aware_utils.js';

class TestCodeExecutor extends BaseCodeExecutor {
  async executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return {stdout: '', stderr: '', outputFiles: []};
  }
}

/** The delimiters every executor inherits, read from the base class itself. */
const DEFAULT_DELIMITERS = new TestCodeExecutor().codeBlockDelimiters;

// ---------------------------------------------------------------------------
// getEncodedFileContent
// ---------------------------------------------------------------------------
describe('getEncodedFileContent', () => {
  it('returns data unchanged when already base64 encoded', () => {
    const encoded = base64Encode('hello world');
    expect(getEncodedFileContent(encoded)).toBe(encoded);
  });

  it('base64-encodes plain text that is not already encoded', () => {
    const plain = 'hello world';
    const result = getEncodedFileContent(plain);
    expect(result).toBe(base64Encode(plain));
  });

  it('handles empty string', () => {
    const result = getEncodedFileContent('');
    // empty string is valid base64 (empty), so it should come back unchanged or encoded
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// buildExecutableCodePart
// ---------------------------------------------------------------------------
describe('buildExecutableCodePart', () => {
  it('builds a part with text and executableCode fields', () => {
    const code = 'print("hello")';
    const part = buildExecutableCodePart(code);
    expect(part.text).toBe(code);
    expect(part.executableCode).toBeDefined();
    expect(part.executableCode!.code).toBe(code);
  });

  it('sets language to PYTHON', () => {
    const part = buildExecutableCodePart('1 + 1');
    expect(part.executableCode!.language).toBe(Language.PYTHON);
  });

  it('handles empty code string', () => {
    const part = buildExecutableCodePart('');
    expect(part.text).toBe('');
    expect(part.executableCode!.code).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildCodeExecutionResultPart
// ---------------------------------------------------------------------------
describe('buildCodeExecutionResultPart', () => {
  it('returns OUTCOME_FAILED when stderr is set', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '',
      stderr: 'NameError: x',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.outcome).toBe(Outcome.OUTCOME_FAILED);
    expect(part.text).toBe('NameError: x');
  });

  it('returns OUTCOME_OK with stdout when no stderr', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '42',
      stderr: '',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.outcome).toBe(Outcome.OUTCOME_OK);
    expect(part.text).toContain('42');
  });

  it('includes output file names in successful result', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '',
      stderr: '',
      outputFiles: [
        {name: 'chart.png', content: 'abc', mimeType: 'image/png'},
        {name: 'data.csv', content: 'xyz', mimeType: 'text/csv'},
      ],
    });
    expect(part.codeExecutionResult!.outcome).toBe(Outcome.OUTCOME_OK);
    expect(part.text).toContain('chart.png');
    expect(part.text).toContain('data.csv');
  });

  it('includes both stdout and saved artifacts when both present', () => {
    const part = buildCodeExecutionResultPart({
      stdout: 'done',
      stderr: '',
      outputFiles: [{name: 'out.txt', content: '', mimeType: 'text/plain'}],
    });
    expect(part.text).toContain('done');
    expect(part.text).toContain('out.txt');
  });

  it('prefers stderr over stdout when both are set', () => {
    const part = buildCodeExecutionResultPart({
      stdout: 'some output',
      stderr: 'error occurred',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.outcome).toBe(Outcome.OUTCOME_FAILED);
    expect(part.text).toBe('error occurred');
  });
});

// ---------------------------------------------------------------------------
// extractCodeAndTruncateContent
// ---------------------------------------------------------------------------
const PYTHON_DELIMITERS: Array<[string, string]> = [
  ['```python\n', '\n```'],
  ['```tool_code\n', '\n```'],
];

describe('extractCodeAndTruncateContent', () => {
  it('returns empty string when content has no parts', () => {
    const content = {parts: [], role: 'model'};
    expect(extractCodeAndTruncateContent(content, PYTHON_DELIMITERS)).toBe('');
  });

  it('returns empty string when parts is undefined', () => {
    const content = {role: 'model'} as unknown as Content;
    expect(extractCodeAndTruncateContent(content, PYTHON_DELIMITERS)).toBe('');
  });

  it('extracts code from executableCode part without following result', () => {
    const code = 'print("hi")';
    const content = {
      parts: [{executableCode: {code, language: Language.PYTHON}}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe(code);
    expect(content.parts).toHaveLength(1);
  });

  it('skips executableCode part when followed by codeExecutionResult', () => {
    const code = 'print("hi")';
    const content = {
      parts: [
        {executableCode: {code, language: Language.PYTHON}},
        {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hi'}},
        {executableCode: {code: 'x=1', language: Language.PYTHON}},
      ],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('x=1');
  });

  it('extracts code block from text parts', () => {
    const content = {
      parts: [{text: '```python\nprint("hello")\n```'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('print("hello")');
  });

  it('extracts code and preserves prefix text', () => {
    const content = {
      parts: [{text: 'Here is the code:\n```python\nx = 1\n```'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('x = 1');
    // prefix text part should be present
    const textParts = content.parts.filter(
      (p) => p.text && !('executableCode' in p),
    );
    expect(textParts.some((p) => p.text!.includes('Here is the code:'))).toBe(
      true,
    );
  });

  it('returns empty string when no code block found in text', () => {
    const content = {
      parts: [{text: 'just some text, no code block'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('');
  });

  it('returns empty string when parts exist but none have text or executableCode', () => {
    const content = {
      parts: [{inlineData: {mimeType: 'image/png', data: 'abc'}}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('');
  });

  it('truncates content after the first executableCode part', () => {
    const code1 = 'a = 1';
    const code2 = 'b = 2';
    const content = {
      parts: [
        {executableCode: {code: code1, language: Language.PYTHON}},
        {executableCode: {code: code2, language: Language.PYTHON}},
      ],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    // first executableCode has no following codeExecutionResult, so it's extracted
    expect(result).toBe(code1);
    expect(content.parts).toHaveLength(1);
  });

  it('handles tool_code delimiter', () => {
    const content = {
      parts: [{text: '```tool_code\nmy_function()\n```'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('my_function()');
  });

  it('handles multi-part text joined together', () => {
    const content = {
      parts: [{text: 'Part 1\n'}, {text: '```python\nmy_code()\n```'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('my_code()');
  });
});

// ---------------------------------------------------------------------------
// convertCodeExecutionParts
// ---------------------------------------------------------------------------
describe('convertCodeExecutionParts', () => {
  const CODE_DELIM: [string, string] = ['```python\n', '\n```'];
  const RESULT_DELIM: [string, string] = ['```tool_output\n', '\n```'];

  it('does nothing when parts is empty', () => {
    const content = {parts: [], role: 'model'};
    convertCodeExecutionParts(content, [CODE_DELIM], RESULT_DELIM);
    expect(content.parts).toHaveLength(0);
  });

  it('does nothing when parts is undefined', () => {
    const content = {role: 'model'} as unknown as Content;
    convertCodeExecutionParts(content, [CODE_DELIM], RESULT_DELIM);
    expect(content.parts).toBeUndefined();
  });

  it('converts last executableCode part to text', () => {
    const content: Content = {
      parts: [{executableCode: {code: 'x = 1', language: Language.PYTHON}}],
      role: 'model',
    };
    convertCodeExecutionParts(content, [CODE_DELIM], RESULT_DELIM);
    expect(content.parts![0].text).toBe('```python\nx = 1\n```');
    expect(content.parts![0].executableCode).toBeUndefined();
  });

  it('converts single codeExecutionResult part to text and sets role to user', () => {
    const content: Content = {
      parts: [
        {
          codeExecutionResult: {
            outcome: Outcome.OUTCOME_OK,
            output: 'hello',
          },
        },
      ],
      role: 'model',
    };
    convertCodeExecutionParts(content, [CODE_DELIM], RESULT_DELIM);
    expect(content.parts![0].text).toBe('```tool_output\nhello\n```');
    expect(content.role).toBe('user');
  });

  it('does not convert codeExecutionResult when there are multiple parts', () => {
    const content = {
      parts: [
        {text: 'some text'},
        {
          codeExecutionResult: {
            outcome: Outcome.OUTCOME_OK,
            output: 'hello',
          },
        },
      ],
      role: 'model',
    };
    convertCodeExecutionParts(content, [CODE_DELIM], RESULT_DELIM);
    // last part has codeExecutionResult but length > 1, so no conversion
    expect(content.parts[1].codeExecutionResult).toBeDefined();
    expect(content.role).toBe('model');
  });

  it('does not modify parts that are plain text', () => {
    const content = {
      parts: [{text: 'just text'}],
      role: 'model',
    };
    convertCodeExecutionParts(content, [CODE_DELIM], RESULT_DELIM);
    expect(content.parts[0].text).toBe('just text');
    expect(content.role).toBe('model');
  });
});

// ---------------------------------------------------------------------------
// selectCodeBlockDelimiter
// ---------------------------------------------------------------------------
describe('selectCodeBlockDelimiter', () => {
  const PYTHON_PART: Part = {
    executableCode: {code: 'x = 1', language: Language.PYTHON},
  };

  it('picks the python fence from the default list, not the first pair', () => {
    const selected = selectCodeBlockDelimiter(PYTHON_PART, DEFAULT_DELIMITERS);

    expect(selected).toEqual(['```python\n', '\n```']);
    expect(selected).not.toBe(DEFAULT_DELIMITERS[0]);
  });

  it('falls back to the first pair when the part declares no language', () => {
    const part: Part = {executableCode: {code: 'x = 1'}};

    expect(selectCodeBlockDelimiter(part, DEFAULT_DELIMITERS)).toEqual([
      '```tool_code\n',
      '\n```',
    ]);
  });

  it('falls back to the first pair for an unspecified language', () => {
    const part: Part = {
      executableCode: {code: 'x = 1', language: Language.LANGUAGE_UNSPECIFIED},
    };

    expect(selectCodeBlockDelimiter(part, DEFAULT_DELIMITERS)).toEqual([
      '```tool_code\n',
      '\n```',
    ]);
  });

  it('falls back to the first pair when no fence names the language', () => {
    const custom: Array<[string, string]> = [['<code>', '</code>']];

    expect(selectCodeBlockDelimiter(PYTHON_PART, custom)).toEqual([
      '<code>',
      '</code>',
    ]);
  });

  it('returns an empty pair for an empty delimiter list', () => {
    expect(selectCodeBlockDelimiter(PYTHON_PART, [])).toEqual(['', '']);
  });

  it('matches the fence case-insensitively', () => {
    // Language.PYTHON is 'PYTHON', so an exact compare against the lowercase
    // fence tag would never match.
    const part: Part = {
      executableCode: {code: 'x = 1', language: Language.PYTHON},
    };

    expect(selectCodeBlockDelimiter(part, DEFAULT_DELIMITERS)).toEqual([
      '```python\n',
      '\n```',
    ]);
  });
});

// ---------------------------------------------------------------------------
// convertCodeExecutionParts with the executor's full delimiter list
// ---------------------------------------------------------------------------
describe('convertCodeExecutionParts with the default delimiter list', () => {
  const RESULT_DELIM: [string, string] = ['```tool_output\n', '\n```'];

  it('renders a python part with the python fence', () => {
    const content: Content = {
      parts: [{executableCode: {code: 'x = 1', language: Language.PYTHON}}],
      role: 'model',
    };

    convertCodeExecutionParts(content, DEFAULT_DELIMITERS, RESULT_DELIM);

    expect(content.parts![0].text).toBe('```python\nx = 1\n```');
  });

  it('renders a code execution result with the result delimiters', () => {
    const content: Content = {
      parts: [
        {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hello'}},
      ],
      role: 'model',
    };

    convertCodeExecutionParts(content, DEFAULT_DELIMITERS, RESULT_DELIM);

    expect(content.parts![0].text).toBe('```tool_output\nhello\n```');
    expect(content.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Enums and interfaces
// ---------------------------------------------------------------------------
describe('FileContentEncoding', () => {
  it('has UTF8 and BASE64 values', () => {
    expect(FileContentEncoding.UTF8).toBe('utf-8');
    expect(FileContentEncoding.BASE64).toBe('base64');
  });
});

describe('CodeExecutionLanguage', () => {
  it('has expected language values', () => {
    expect(CodeExecutionLanguage.UNSPECIFIED).toBe('unspecified');
    expect(CodeExecutionLanguage.PYTHON).toBe('python');
    expect(CodeExecutionLanguage.JAVASCRIPT).toBe('javascript');
    expect(CodeExecutionLanguage.TYPESCRIPT).toBe('typescript');
    expect(CodeExecutionLanguage.SHELL).toBe('shell');
    expect(CodeExecutionLanguage.POWERSHELL).toBe('powershell');
    expect(CodeExecutionLanguage.WINDOWS_CMD).toBe('cmd');
  });
});
