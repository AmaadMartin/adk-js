/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  CheckRequireConfirmationRequest,
  Context,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  RunAsyncToolRequest,
  ToolConfirmation,
  createEvent,
  createSession,
  functionsExportedForTestingOnly,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

const {handleFunctionCallList, generateRequestConfirmationEvent} =
  functionsExportedForTestingOnly;

const REQUEST_CONFIRMATION_ERROR =
  'This tool call requires confirmation, please approve or reject.';
const REJECTED_ERROR = 'This tool call is rejected.';

/** A tool that never overrides the hook, i.e. every tool on `main` today. */
class PlainTool extends BaseTool {
  readonly calls: Array<Record<string, unknown>> = [];

  constructor() {
    super({name: 'echo', description: 'Echoes its arguments.'});
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    this.calls.push(args);
    return {result: 'echoed'};
  }
}

/** A tool that gates one destructive statement and lets the rest through. */
class DatabaseTool extends BaseTool {
  readonly calls: Array<Record<string, unknown>> = [];

  constructor() {
    super({name: 'database', description: 'Runs a database statement.'});
  }

  override async checkRequireConfirmation({
    args,
  }: CheckRequireConfirmationRequest): Promise<boolean> {
    return args['statement'] === 'DROP TABLE users';
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    this.calls.push(args);
    return {result: 'executed'};
  }
}

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'agent', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
}

function makeToolContext(functionCallId: string): Context {
  return new Context({
    invocationContext: makeInvocationContext(),
    functionCallId,
  });
}

/** Drives one function call through the shared tool-execution path. */
async function callThroughFlow(
  tool: BaseTool,
  functionCall: FunctionCall,
  toolConfirmationDict?: Record<string, ToolConfirmation>,
): Promise<Event> {
  const event = await handleFunctionCallList({
    invocationContext: makeInvocationContext(),
    functionCalls: [functionCall],
    toolsDict: {[tool.name]: tool},
    beforeToolCallbacks: [],
    afterToolCallbacks: [],
    toolConfirmationDict,
  });
  if (!event) {
    expect.fail(`no response event for ${functionCall.name}`);
  }
  return event;
}

function responseOf(event: Event): unknown {
  return event.content!.parts![0].functionResponse!.response;
}

function confirmationIds(event: Event): string[] {
  return Object.keys(event.actions!.requestedToolConfirmations);
}

describe('BaseTool.checkRequireConfirmation', () => {
  it('defaults to false', async () => {
    const tool = new PlainTool();

    const required = await tool.checkRequireConfirmation({
      args: {message: 'hi'},
      toolContext: makeToolContext('fc-1'),
    });

    expect(required).toBe(false);
  });

  it('leaves the execution path untouched for a tool that does not override it', async () => {
    const tool = new PlainTool();

    const event = await callThroughFlow(tool, {
      id: 'fc-1',
      name: 'echo',
      args: {message: 'hi'},
    });

    expect(responseOf(event)).toEqual({result: 'echoed'});
    expect(tool.calls).toEqual([{message: 'hi'}]);
    expect(confirmationIds(event)).toEqual([]);
    expect(event.actions!.skipSummarization).toBeFalsy();
  });

  it('gates the arguments the hook selects and runs the others', async () => {
    const tool = new DatabaseTool();

    const gated = await callThroughFlow(tool, {
      id: 'fc-drop',
      name: 'database',
      args: {statement: 'DROP TABLE users'},
    });

    expect(responseOf(gated)).toEqual({error: REQUEST_CONFIRMATION_ERROR});
    expect(tool.calls).toEqual([]);
    expect(confirmationIds(gated)).toEqual(['fc-drop']);
    expect(gated.actions!.skipSummarization).toBe(true);

    const allowed = await callThroughFlow(tool, {
      id: 'fc-select',
      name: 'database',
      args: {statement: 'SELECT 1'},
    });

    expect(responseOf(allowed)).toEqual({result: 'executed'});
    expect(tool.calls).toEqual([{statement: 'SELECT 1'}]);
    expect(confirmationIds(allowed)).toEqual([]);
  });

  it('runs the gated call once the user approves', async () => {
    const tool = new DatabaseTool();

    const event = await callThroughFlow(
      tool,
      {id: 'fc-drop', name: 'database', args: {statement: 'DROP TABLE users'}},
      {'fc-drop': new ToolConfirmation({confirmed: true})},
    );

    expect(responseOf(event)).toEqual({result: 'executed'});
    expect(tool.calls).toEqual([{statement: 'DROP TABLE users'}]);
  });

  it('refuses the gated call once the user declines', async () => {
    const tool = new DatabaseTool();

    const event = await callThroughFlow(
      tool,
      {id: 'fc-drop', name: 'database', args: {statement: 'DROP TABLE users'}},
      {'fc-drop': new ToolConfirmation({confirmed: false})},
    );

    expect(responseOf(event)).toEqual({error: REJECTED_ERROR});
    expect(tool.calls).toEqual([]);
  });

  it('surfaces the gate as an adk_request_confirmation interrupt', async () => {
    const tool = new DatabaseTool();
    const originalFunctionCall: FunctionCall = {
      id: 'fc-drop',
      name: 'database',
      args: {statement: 'DROP TABLE users'},
    };
    const functionResponseEvent = await callThroughFlow(
      tool,
      originalFunctionCall,
    );

    const interrupt = generateRequestConfirmationEvent({
      invocationContext: makeInvocationContext(),
      functionCallEvent: createEvent({
        content: {
          role: 'model',
          parts: [{functionCall: originalFunctionCall}],
        },
      }),
      functionResponseEvent,
    });

    expect(interrupt).toBeDefined();
    const parts = interrupt!.content!.parts!;
    expect(parts).toHaveLength(1);
    expect(parts[0].functionCall!.name).toBe(
      REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
    );
    expect(parts[0].functionCall!.args!['originalFunctionCall']).toEqual(
      originalFunctionCall,
    );
  });
});

describe('the shared tool-execution path', () => {
  it('gates a FunctionTool that declares no parameter schema', async () => {
    let ran = false;
    const tool = new FunctionTool({
      name: 'reboot',
      description: 'Reboots the machine.',
      execute: () => {
        ran = true;
        return 'rebooted';
      },
      requireConfirmation: true,
    });

    const event = await callThroughFlow(tool, {id: 'fc-1', name: 'reboot'});

    expect(responseOf(event)).toEqual({error: REQUEST_CONFIRMATION_ERROR});
    expect(ran).toBe(false);
    expect(confirmationIds(event)).toEqual(['fc-1']);
  });

  it('reports the validation error instead of gating invalid arguments', async () => {
    let ran = false;
    const tool = new FunctionTool({
      name: 'transfer',
      description: 'Transfers money.',
      parameters: z.object({amount: z.number()}),
      execute: () => {
        ran = true;
        return 'sent';
      },
      requireConfirmation: true,
    });

    const event = await callThroughFlow(tool, {
      id: 'fc-1',
      name: 'transfer',
      args: {amount: 'not-a-number'},
    });

    const response = responseOf(event) as {error: string};
    expect(response.error).toContain("Error in tool 'transfer'");
    expect(ran).toBe(false);
    expect(confirmationIds(event)).toEqual([]);
  });
});
