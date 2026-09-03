/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionCall} from '@google/genai';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import type {BaseTool, Context, Session} from '../../src/index.js';
import {
  createEventActions,
  functionsExportedForTestingOnly,
  getUserChoice,
  getUserChoiceTool,
  InvocationContext,
  LlmAgent,
  LongRunningFunctionTool,
  PluginManager,
} from '../../src/index.js';

describe('getUserChoice', () => {
  it('sets skipSummarization and returns null', () => {
    const actions = createEventActions();
    const context = {actions} as unknown as Context;

    expect(getUserChoice({options: ['a', 'b']}, context)).toBeNull();
    expect(actions.skipSummarization).toBe(true);
  });
});

describe('getUserChoiceTool', () => {
  it('computes the correct declaration', () => {
    const declaration = getUserChoiceTool._getDeclaration();
    expect(declaration?.name).toEqual('get_user_choice');
    expect(declaration?.description).toContain('Provides the options');
  });

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

  it('sets skipSummarization flag on execution', async () => {
    const mockActions = createEventActions();
    const mockContext = {actions: mockActions} as unknown as Context;

    const result = await getUserChoiceTool.runAsync({
      args: {options: ['A', 'B']},
      toolContext: mockContext,
    });

    expect(result).toBeNull();
    expect(mockActions.skipSummarization).toBe(true);
  });
});

// End-to-end exercise through the real function-calling machinery (no mocks):
// drives getUserChoiceTool via handleFunctionCallList with a real
// InvocationContext, proving the call is left pending (no function response) so
// the turn pauses for the user's selection.
//
// A deferred tool that records actions now yields an actions-only event instead
// of no event at all, so the pending call is proved by the absence of content.
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

    expect(event?.content).toBeUndefined();
    expect(event?.actions.skipSummarization).toBe(true);
  });
});
