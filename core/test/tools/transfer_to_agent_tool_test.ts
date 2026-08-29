/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Context,
  createSession,
  InvocationContext,
  isFunctionTool,
  LlmRequest,
  PluginManager,
  TRANSFER_TO_AGENT_TOOL_NAME,
  transferToAgent,
  TransferToAgentTool,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

class MockAgent extends BaseAgent {
  constructor(name: string) {
    super({name, description: ''});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new MockAgent('root_agent'),
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

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

describe('TransferToAgentTool', () => {
  it('constrains agentName to the given agent names', () => {
    const tool = new TransferToAgentTool({
      agentNames: ['agent_a', 'agent_b', 'agent_c'],
    });

    const declaration = tool._getDeclaration();

    expect(declaration.name).toBe(TRANSFER_TO_AGENT_TOOL_NAME);
    expect(declaration.parameters?.type).toBe(Type.OBJECT);
    expect(declaration.parameters?.required).toEqual(['agentName']);
    expect(declaration.parameters?.properties?.['agentName']?.enum).toEqual([
      'agent_a',
      'agent_b',
      'agent_c',
    ]);
  });

  it('constrains agentName to a single agent name', () => {
    const tool = new TransferToAgentTool({agentNames: ['single_agent']});

    expect(
      tool._getDeclaration().parameters?.properties?.['agentName']?.enum,
    ).toEqual(['single_agent']);
  });

  it('keeps every agent name when there are many', () => {
    const agentNames = ['one', 'two', 'three', 'four', 'five'];
    const tool = new TransferToAgentTool({agentNames});

    const declaredEnum =
      tool._getDeclaration().parameters?.properties?.['agentName']?.enum;

    expect(declaredEnum).toEqual(agentNames);
    expect(declaredEnum).toHaveLength(5);
  });

  it('declares an empty enum when there are no agent names', () => {
    const tool = new TransferToAgentTool({agentNames: []});

    const agentNameSchema =
      tool._getDeclaration().parameters?.properties?.['agentName'];

    expect(agentNameSchema).toBeDefined();
    expect(agentNameSchema?.enum).toEqual([]);
  });

  it('leaves the parameter type and description intact', () => {
    const tool = new TransferToAgentTool({agentNames: ['agent_a']});

    const agentNameSchema =
      tool._getDeclaration().parameters?.properties?.['agentName'];

    expect(agentNameSchema?.type).toBe(Type.STRING);
    expect(agentNameSchema?.description).toBe('the agent name to transfer to.');
  });

  it('declares agentName as its only parameter', () => {
    const tool = new TransferToAgentTool({agentNames: ['agent_a']});

    expect(
      Object.keys(tool._getDeclaration().parameters?.properties ?? {}),
    ).toEqual(['agentName']);
  });

  it('describes the hand-off to the model', () => {
    const tool = new TransferToAgentTool({agentNames: ['agent_a']});

    const description = tool._getDeclaration().description ?? '';

    expect(description).toContain('another agent');
  });

  it('is a function tool', () => {
    const tool = new TransferToAgentTool({agentNames: ['agent_a']});

    expect(isFunctionTool(tool)).toBe(true);
  });

  it('returns an equal declaration on every call', () => {
    const tool = new TransferToAgentTool({agentNames: ['agent_a', 'agent_b']});

    expect(tool._getDeclaration()).toEqual(tool._getDeclaration());
  });

  it('ignores a later mutation of the agent names it was given', () => {
    const agentNames = ['agent_a'];
    const tool = new TransferToAgentTool({agentNames});

    agentNames.push('agent_b');

    expect(
      tool._getDeclaration().parameters?.properties?.['agentName']?.enum,
    ).toEqual(['agent_a']);
  });

  it('queues the hand-off when the model calls it', async () => {
    const tool = new TransferToAgentTool({agentNames: ['sub_agent']});
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {agentName: 'sub_agent'},
      toolContext,
    });

    expect(result).toBe('Transfer queued');
    expect(toolContext.actions.transferToAgent).toBe('sub_agent');
  });

  it('registers the enum-carrying declaration on the request', async () => {
    const tool = new TransferToAgentTool({agentNames: ['agent_a', 'agent_b']});
    const llmRequest = createLlmRequest();

    await tool.processLlmRequest({
      toolContext: createToolContext(),
      llmRequest,
    });

    expect(llmRequest.toolsDict[TRANSFER_TO_AGENT_TOOL_NAME]).toBe(tool);
    const [registeredTool] = llmRequest.config?.tools ?? [];
    if (!registeredTool || !('functionDeclarations' in registeredTool)) {
      expect.fail('the request carries no function declarations');
    }
    const declaration = registeredTool.functionDeclarations?.[0];
    expect(declaration?.name).toBe(TRANSFER_TO_AGENT_TOOL_NAME);
    expect(declaration?.parameters?.properties?.['agentName']?.enum).toEqual([
      'agent_a',
      'agent_b',
    ]);
  });

  it('rejects a call whose agentName is missing', async () => {
    const tool = new TransferToAgentTool({agentNames: ['agent_a']});

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow(/^Error in tool 'transfer_to_agent': /);
  });

  it('rejects a call whose agentName is not a string', async () => {
    const tool = new TransferToAgentTool({agentNames: ['agent_a']});

    await expect(
      tool.runAsync({args: {agentName: 42}, toolContext: createToolContext()}),
    ).rejects.toThrow(/^Error in tool 'transfer_to_agent': /);
  });
});

describe('transferToAgent', () => {
  it('records the target agent on the tool context', () => {
    const toolContext = createToolContext();

    const result = transferToAgent({agentName: 'sub_agent'}, toolContext);

    expect(result).toBe('Transfer queued');
    expect(toolContext.actions.transferToAgent).toBe('sub_agent');
  });

  it('throws when there is no tool context', () => {
    expect(() => transferToAgent({agentName: 'sub_agent'})).toThrow(
      'toolContext is required.',
    );
  });
});
