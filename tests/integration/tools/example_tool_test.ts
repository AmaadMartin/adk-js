/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  Example,
  ExampleTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * `core/test` reaches ADK symbols through a relative path into `core/src`, so
 * nothing there can pin the *published* surface. This file imports through the
 * `@google/adk` specifier instead, which `tsc` resolves to the declarations in
 * `core/dist/types`: a symbol dropped from the built package fails here even
 * though the source barrel still exports it.
 */

const EXAMPLE: Example = {
  input: {parts: [{text: 'What is 2+2?'}]},
  output: [{role: 'model', parts: [{text: '4'}]}],
};

function makeContext(text: string): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'}),
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager([]),
    userContent: {role: 'user', parts: [{text}]},
  });
  return new Context({invocationContext});
}

describe('ExampleTool via the @google/adk package specifier', () => {
  it('appends the few-shot block to an outgoing request', async () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
      model: 'gemini-2.0-flash',
    };

    await new ExampleTool([EXAMPLE]).processLlmRequest({
      toolContext: makeContext('What is 2+2?'),
      llmRequest,
    });

    const instruction = llmRequest.config?.systemInstruction;
    expect(instruction).toContain('<EXAMPLES>');
    expect(instruction).toContain('What is 2+2?');
    expect(instruction).toContain('4');
  });
});
