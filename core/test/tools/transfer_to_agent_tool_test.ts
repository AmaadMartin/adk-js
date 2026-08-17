/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  isFunctionTool,
  LlmAgent,
  PluginManager,
  TRANSFER_TO_AGENT_TOOL_NAME,
  TransferToAgentTool,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createToolContext(): Context {
  const agent = new LlmAgent({name: 'root_agent', model: 'gemini-2.5-flash'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession({
        id: 'test-session',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('TransferToAgentTool', () => {
  it('declares the transfer function with an agentName parameter', () => {
    const declaration = new TransferToAgentTool(['agent_a'])._getDeclaration();

    expect(declaration.name).toEqual(TRANSFER_TO_AGENT_TOOL_NAME);
    expect(declaration.description).not.toEqual('');
    expect(declaration.parameters?.type).toEqual(Type.OBJECT);
    expect(declaration.parameters?.properties).toHaveProperty('agentName');
  });

  it('constrains agentName to the given agent names', () => {
    const agentNames = ['agent_a', 'agent_b', 'agent_c'];

    const declaration = new TransferToAgentTool(agentNames)._getDeclaration();

    expect(declaration.parameters?.properties?.['agentName'].enum).toEqual(
      agentNames,
    );
    expect(declaration.parameters?.required).toEqual(['agentName']);
  });

  it('constrains agentName to a single agent name', () => {
    const declaration = new TransferToAgentTool([
      'single_agent',
    ])._getDeclaration();

    expect(declaration.parameters?.properties?.['agentName'].enum).toEqual([
      'single_agent',
    ]);
  });

  it('preserves the order of many agent names', () => {
    const agentNames = ['agent_1', 'agent_2', 'agent_3', 'agent_4', 'agent_5'];

    const declaration = new TransferToAgentTool(agentNames)._getDeclaration();

    expect(declaration.parameters?.properties?.['agentName'].enum).toEqual(
      agentNames,
    );
  });

  it('declares an empty enum when there are no agent names', () => {
    const declaration = new TransferToAgentTool([])._getDeclaration();

    expect(declaration.parameters?.properties?.['agentName'].enum).toEqual([]);
  });

  it('keeps agentName a string parameter', () => {
    const declaration = new TransferToAgentTool(['agent_a'])._getDeclaration();

    expect(declaration.parameters?.properties?.['agentName'].type).toEqual(
      Type.STRING,
    );
  });

  it('declares no parameter other than agentName', () => {
    const declaration = new TransferToAgentTool(['agent_a'])._getDeclaration();

    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'agentName',
    ]);
  });

  it('returns an independent declaration on every call', () => {
    const tool = new TransferToAgentTool(['agent_a', 'agent_b']);

    const first = tool._getDeclaration();
    first.parameters?.properties?.['agentName'].enum?.push('agent_c');
    const second = tool._getDeclaration();

    expect(second.parameters?.properties?.['agentName'].enum).toEqual([
      'agent_a',
      'agent_b',
    ]);
  });

  it('queues the transfer when the model calls it', async () => {
    const tool = new TransferToAgentTool(['agent_a']);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {agentName: 'agent_a'},
      toolContext,
    });

    expect(result).toEqual('Transfer queued');
    expect(toolContext.actions.transferToAgent).toEqual('agent_a');
  });

  it('rejects an agentName that is not a string', async () => {
    const tool = new TransferToAgentTool(['agent_a']);
    const toolContext = createToolContext();

    await expect(
      tool.runAsync({args: {agentName: 42}, toolContext}),
    ).rejects.toThrowError(`Error in tool '${TRANSFER_TO_AGENT_TOOL_NAME}'`);
    expect(toolContext.actions.transferToAgent).toBeUndefined();
  });

  it('is a function tool', () => {
    expect(isFunctionTool(new TransferToAgentTool(['agent_a']))).toBe(true);
  });
});
