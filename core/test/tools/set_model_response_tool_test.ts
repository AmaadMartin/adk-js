/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createSetModelResponseTool} from '../../src/tools/set_model_response_tool.js';

const OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

function createToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

describe('createSetModelResponseTool', () => {
  it('declares the output schema as its parameters', () => {
    const tool = createSetModelResponseTool(OUTPUT_SCHEMA);

    expect(tool.name).toBe('set_model_response');
    expect(tool._getDeclaration()?.name).toBe('set_model_response');
    expect(tool._getDeclaration()?.parameters).toEqual(OUTPUT_SCHEMA);
  });

  it('returns the arguments as JSON and skips summarization', async () => {
    const tool = createSetModelResponseTool(OUTPUT_SCHEMA);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {answer: 'forty two'},
      toolContext,
    });

    expect(result).toBe('{"answer":"forty two"}');
    expect(toolContext.actions.skipSummarization).toBe(true);
  });
});
