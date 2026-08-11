/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  BaseCodeExecutor,
  ExecuteCodeParams,
  isBaseCodeExecutor,
} from '../../src/code_executors/base_code_executor.js';
import {
  ALL_CODE_EXECUTION_LANGUAGES,
  CodeExecutionLanguage,
  CodeExecutionResult,
} from '../../src/code_executors/code_execution_utils.js';

class TestExecutor extends BaseCodeExecutor {
  async executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return {stdout: '', stderr: '', outputFiles: []};
  }
}

describe('BaseCodeExecutor', () => {
  it('should have default values', () => {
    const executor = new TestExecutor();
    expect(executor.optimizeDataFile).toBe(false);
    expect(executor.stateful).toBe(false);
    expect(executor.errorRetryAttempts).toBe(2);
  });

  it('supports every language by default', () => {
    const executor = new TestExecutor();

    expect(executor.supportedLanguages).toEqual(ALL_CODE_EXECUTION_LANGUAGES);
    expect(
      executor.supportedLanguages.has(CodeExecutionLanguage.UNSPECIFIED),
    ).toBe(false);
  });

  // A third-party subclass that does not declare supportedLanguages must keep
  // accepting what it accepted before the property existed.
  it('lets a subclass that does not narrow the set accept shell', () => {
    expect(
      new TestExecutor().supportedLanguages.has(CodeExecutionLanguage.SHELL),
    ).toBe(true);
  });

  it('should have default delimiters', () => {
    const executor = new TestExecutor();
    const bt = String.fromCharCode(96);
    const threeBt = bt + bt + bt;

    expect(executor.codeBlockDelimiters).toEqual([
      [threeBt + 'tool_code\n', '\n' + threeBt],
      [threeBt + 'python\n', '\n' + threeBt],
      [threeBt + 'javascript\n', '\n' + threeBt],
      [threeBt + 'typescript\n', '\n' + threeBt],
      [threeBt + 'bash\n', '\n' + threeBt],
      [threeBt + 'sh\n', '\n' + threeBt],
    ]);

    expect(executor.executionResultDelimiters).toEqual([
      threeBt + 'tool_output\n',
      '\n' + threeBt,
    ]);
  });

  it('should identify instances', () => {
    const executor = new TestExecutor();
    expect(isBaseCodeExecutor(executor)).toBe(true);
  });

  it('should reject non-instances', () => {
    expect(isBaseCodeExecutor({})).toBe(false);
    expect(isBaseCodeExecutor(null)).toBe(false);
    expect(isBaseCodeExecutor(undefined)).toBe(false);

    // Test with symbol
    const objWithSymbol = {};
    Object.defineProperty(
      objWithSymbol,
      Symbol.for('google.adk.baseCodeExecutor'),
      {
        value: true,
        enumerable: true,
      },
    );
    expect(isBaseCodeExecutor(objWithSymbol)).toBe(true);
  });
});
