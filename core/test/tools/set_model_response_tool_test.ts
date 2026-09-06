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
import {z} from 'zod/v4';
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

/** The validator an agent declaring `OUTPUT_SCHEMA` in Zod would supply. */
const validateOutput = (value: unknown): unknown =>
  z.object({answer: z.string()}).parse(value);

describe('createSetModelResponseTool', () => {
  it('declares the output schema as its parameters', () => {
    const tool = createSetModelResponseTool(OUTPUT_SCHEMA, validateOutput);

    expect(tool.name).toBe('set_model_response');
    expect(tool._getDeclaration()?.name).toBe('set_model_response');
    expect(tool._getDeclaration()?.parameters).toEqual(OUTPUT_SCHEMA);
  });

  it('records a valid answer on the actions and returns it', async () => {
    const tool = createSetModelResponseTool(OUTPUT_SCHEMA, validateOutput);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {answer: 'forty two'},
      toolContext,
    });

    expect(result).toEqual({answer: 'forty two'});
    expect(toolContext.actions.setModelResponse).toEqual({
      answer: 'forty two',
    });
  });

  it('reports a schema violation to the model and records nothing', async () => {
    const tool = createSetModelResponseTool(OUTPUT_SCHEMA, validateOutput);
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {answer: 42}, toolContext});

    expect(result).toMatchObject({
      error: expect.stringContaining('Validation Error found:'),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('reports a validator that throws a non-Error value', async () => {
    const tool = createSetModelResponseTool(OUTPUT_SCHEMA, () => {
      throw 'answer is required';
    });
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual({
      error:
        'Validation Error found:\nanswer is required\nRecall the set_model_response function correctly, fix the errors, and call it again with all required fields using the correct types.',
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('leaves summarization enabled, so the flow decides what follows', async () => {
    const tool = createSetModelResponseTool(OUTPUT_SCHEMA, validateOutput);
    const toolContext = createToolContext();

    await tool.runAsync({args: {answer: 'forty two'}, toolContext});

    expect(toolContext.actions.skipSummarization).toBeUndefined();
  });
});
