/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createEventActions,
  functionsExportedForTestingOnly,
  getUserChoice,
  getUserChoiceTool,
  InvocationContext,
  LlmAgent,
  LongRunningFunctionTool,
  PluginManager,
  Session,
} from '@google/adk';
import {FunctionCall, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('getUserChoice', () => {
  it('sets skipSummarization and returns undefined', () => {
    const actions = createEventActions();
    const context = {actions} as unknown as Context;

    expect(getUserChoice({options: ['a', 'b']}, context)).toBeUndefined();
    expect(actions.skipSummarization).toBe(true);
  });
});

describe('getUserChoiceTool', () => {
  it('is a long-running tool with the parity name and description', () => {
    expect(getUserChoiceTool).toBeInstanceOf(LongRunningFunctionTool);
    expect(getUserChoiceTool.isLongRunning).toBe(true);
    expect(getUserChoiceTool.name).toBe('get_user_choice');
    expect(getUserChoiceTool.description).toBe(
      'Provides the options to the user and asks them to choose one.',
    );
  });

  it('declares an options array-of-string parameter', () => {
    const declaration = getUserChoiceTool._getDeclaration();

    expect(declaration.name).toBe('get_user_choice');
    const options = declaration.parameters?.properties?.['options'];
    expect(options?.type).toBe(Type.ARRAY);
    expect(options?.items?.type).toBe(Type.STRING);
    expect(declaration.parameters?.required).toContain('options');
  });
});

// End-to-end exercise through the real function-calling machinery (no mocks):
// drives getUserChoiceTool via handleFunctionCallList with a real
// InvocationContext, proving the call is left pending (no function-response
// event) so the turn pauses for the user's selection.
describe('getUserChoiceTool end-to-end', () => {
  const {handleFunctionCallList} = functionsExportedForTestingOnly;

  it('leaves the long-running call pending when invoked by the framework', async () => {
    const invocationContext = new InvocationContext({
      invocationId: 'inv_get_user_choice',
      session: {} as Session,
      agent: new LlmAgent({name: 'chooser', model: 'test_model'}),
      pluginManager: new PluginManager(),
    });
    const functionCall: FunctionCall = {
      id: 'call-1',
      name: 'get_user_choice',
      args: {options: ['a', 'b']},
    };
    const toolsDict: Record<string, BaseTool> = {
      'get_user_choice': getUserChoiceTool,
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).toBeNull();
  });
});
