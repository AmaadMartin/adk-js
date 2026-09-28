/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  createSession,
  InvocationContext,
  PluginManager,
  VertexAiCodeExecutor,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * Runs against the real Vertex AI Code Interpreter extension, so it needs
 * Application Default Credentials and a project. Set GOOGLE_CLOUD_PROJECT to
 * enable it. Set CODE_INTERPRETER_EXTENSION_NAME as well to reuse an existing
 * extension instead of creating one.
 */
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;

function buildInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'vertex-ai-code-executor-integration',
    session: createSession({id: 'integration-session', appName: 'integration'}),
    pluginManager: new PluginManager([]),
  });
}

describe.skipIf(!PROJECT_ID)('VertexAiCodeExecutor against Vertex AI', () => {
  it('runs python and returns its stdout', async () => {
    const executor = new VertexAiCodeExecutor({projectId: PROJECT_ID});

    const result = await executor.executeCode({
      invocationContext: buildInvocationContext(),
      codeExecutionInput: {
        code: 'print("hello")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('hello');
  });

  it('returns a generated plot as an output file', async () => {
    const executor = new VertexAiCodeExecutor({projectId: PROJECT_ID});

    const result = await executor.executeCode({
      invocationContext: buildInvocationContext(),
      codeExecutionInput: {
        code: [
          'plt.plot([1, 2, 3], [1, 4, 9])',
          "plt.savefig('plot.png')",
        ].join('\n'),
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    expect(result.stderr).toBe('');
    const plot = result.outputFiles.find((file) => file.name === 'plot.png');
    expect(plot).toBeDefined();
    expect(plot?.mimeType).toBe('image/png');
    expect(plot?.content.length).toBeGreaterThan(0);
  });
});
