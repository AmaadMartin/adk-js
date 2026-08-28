/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createEventActions,
  createSession,
  InvocationContext,
  isBaseTool,
  isFunctionTool,
  LangchainTool,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {Type} from '@google/genai';
import {StructuredTool, Tool, tool} from '@langchain/core/tools';
import {beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

/** A structured `@langchain/core` tool backed by a synchronous function. */
function makeAddTool() {
  return tool(({x, y}: {x: number; y: number}) => x + y, {
    name: 'add',
    description: 'Adds two numbers',
    schema: z.object({x: z.number(), y: z.number()}),
  });
}

/** A `@langchain/core` tool that returns `result` and skips summarization. */
function makeReturnDirectTool(result: unknown) {
  return tool(() => result, {
    name: 'direct',
    description: 'Returns its result unsummarized',
    schema: z.object({}),
    returnDirect: true,
  });
}

/** A context whose actions a test can inspect after a run. */
function makeContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test'}),
      pluginManager: new PluginManager(),
    }),
    eventActions: createEventActions(),
  });
}

describe('LangchainTool', () => {
  let emptyContext: Context;
  beforeEach(() => {
    emptyContext = makeContext();
  });

  it('derives the FunctionDeclaration from the wrapped Zod schema', () => {
    const adkTool = new LangchainTool({tool: makeAddTool()});

    const declaration = adkTool._getDeclaration();
    expect(declaration.name).toEqual('add');
    expect(declaration.description).toEqual('Adds two numbers');
    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        x: {type: Type.NUMBER},
        y: {type: Type.NUMBER},
      },
      required: ['x', 'y'],
    });
  });

  it('proxies execution to invoke() for a synchronous tool', async () => {
    const adkTool = new LangchainTool({tool: makeAddTool()});

    const result = await adkTool.runAsync({
      args: {x: 1, y: 3},
      toolContext: emptyContext,
    });
    expect(result).toEqual(4);
  });

  it('proxies execution to invoke() for an async tool', async () => {
    const asyncAddTool = tool(async ({x, y}: {x: number; y: number}) => x + y, {
      name: 'addAsync',
      description: 'Adds two numbers asynchronously',
      schema: z.object({x: z.number(), y: z.number()}),
    });
    const adkTool = new LangchainTool({tool: asyncAddTool});

    const result = await adkTool.runAsync({
      args: {x: 2, y: 5},
      toolContext: emptyContext,
    });
    expect(result).toEqual(7);
  });

  it('prefers explicit name and description overrides', () => {
    const adkTool = new LangchainTool({
      tool: makeAddTool(),
      name: 'sum',
      description: 'Return the sum of x and y',
    });

    expect(adkTool.name).toEqual('sum');
    expect(adkTool.description).toEqual('Return the sum of x and y');
    const declaration = adkTool._getDeclaration();
    expect(declaration.name).toEqual('sum');
    expect(declaration.description).toEqual('Return the sum of x and y');
  });

  it('is recognized as both a FunctionTool and a BaseTool', () => {
    const adkTool = new LangchainTool({tool: makeAddTool()});

    expect(isFunctionTool(adkTool)).toBe(true);
    expect(isBaseTool(adkTool)).toBe(true);
  });

  it('wraps errors thrown by the underlying tool', async () => {
    const failingTool = tool(
      () => {
        throw new Error('kaboom');
      },
      {
        name: 'failing',
        description: 'Always throws',
        schema: z.object({}),
      },
    );
    const adkTool = new LangchainTool({tool: failingTool});

    await expect(
      adkTool.runAsync({args: {}, toolContext: emptyContext}),
    ).rejects.toThrow("Error in tool 'failing': kaboom");
  });

  it('converts a plain JSON Schema and runs the tool', async () => {
    const jsonSchemaTool = tool((input: {value: number}) => input.value, {
      name: 'echo',
      description: 'Echoes a value',
      schema: {
        type: 'object',
        properties: {value: {type: 'number'}},
        required: ['value'],
      },
    });
    const adkTool = new LangchainTool({tool: jsonSchemaTool});

    expect(adkTool._getDeclaration().parameters).toEqual({
      type: Type.OBJECT,
      properties: {value: {type: Type.NUMBER}},
      required: ['value'],
    });
    await expect(
      adkTool.runAsync({args: {value: 7}, toolContext: emptyContext}),
    ).resolves.toEqual(7);
  });

  it('participates in processLlmRequest like a FunctionTool', async () => {
    const adkTool = new LangchainTool({tool: makeAddTool()});
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await adkTool.processLlmRequest({
      toolContext: emptyContext,
      llmRequest,
    });

    expect(llmRequest.toolsDict['add']).toBe(adkTool);
    const [firstTool] = llmRequest.config?.tools ?? [];
    if (!firstTool || !('functionDeclarations' in firstTool)) {
      expect.fail('processLlmRequest appended no function declarations');
    }
    expect(firstTool.functionDeclarations).toHaveLength(1);
    expect(firstTool.functionDeclarations?.[0].name).toEqual('add');
  });

  it('uses the tool description when no override is given', () => {
    const adkTool = new LangchainTool({tool: makeAddTool(), name: 'sum'});

    expect(adkTool.description).toEqual('Adds two numbers');
  });

  it('falls back to an empty description when the tool has none', () => {
    const adkTool = new LangchainTool({
      tool: {name: 'bare', invoke: () => 'ok'},
    });

    expect(adkTool.description).toEqual('');
  });

  describe('schema conversion', () => {
    it('renders the input side of a string-input Tool schema', async () => {
      class GreetTool extends Tool {
        name = 'greet';
        description = 'Greets the given name';
        protected async _call(input: string): Promise<string> {
          return `hello ${input}`;
        }
      }
      const adkTool = new LangchainTool({tool: new GreetTool()});

      expect(adkTool._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {input: {type: Type.STRING}},
      });
      await expect(
        adkTool.runAsync({args: {input: 'ada'}, toolContext: emptyContext}),
      ).resolves.toEqual('hello ada');
    });

    it('builds a declaration for a StructuredTool subclass', async () => {
      const schema = z.object({word: z.string()});
      class ShoutTool extends StructuredTool<typeof schema> {
        name = 'shout';
        description = 'Uppercases a word';
        schema = schema;
        protected async _call(input: {word: string}): Promise<string> {
          return input.word.toUpperCase();
        }
      }
      const adkTool = new LangchainTool({tool: new ShoutTool()});

      expect(adkTool._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {word: {type: Type.STRING}},
        required: ['word'],
      });
      await expect(
        adkTool.runAsync({args: {word: 'hi'}, toolContext: emptyContext}),
      ).resolves.toEqual('HI');
    });

    it('declares empty parameters when the tool has no schema', () => {
      const adkTool = new LangchainTool({
        tool: {name: 'ping', description: 'Pings', invoke: () => 'pong'},
      });

      expect(adkTool._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {},
      });
    });

    it('rejects a schema that is not an object', () => {
      expect(
        () =>
          new LangchainTool({
            tool: {name: 'bad', invoke: () => 'x', schema: 42},
          }),
      ).toThrow(
        /^Failed to build function declaration for Langchain tool: unsupported schema of type number$/,
      );
    });

    it('rejects an array schema', () => {
      expect(
        () =>
          new LangchainTool({
            tool: {name: 'bad', invoke: () => 'x', schema: []},
          }),
      ).toThrow(/^Failed to build function declaration for Langchain tool: /);
    });
  });

  describe('entry point', () => {
    it('binds the entry point to the wrapped tool', async () => {
      const adkTool = new LangchainTool({
        tool: {
          name: 'selfAware',
          invoke() {
            return this.name;
          },
        },
      });

      await expect(
        adkTool.runAsync({args: {}, toolContext: emptyContext}),
      ).resolves.toEqual('selfAware');
    });

    it('rejects an object with no invoke method', () => {
      expect(() => new LangchainTool({tool: {name: 'nope'}})).toThrow(
        "Tool must be a LangChain tool with an 'invoke' method.",
      );
    });

    it('rejects a tool with no name and no override', () => {
      expect(() => new LangchainTool({tool: {invoke: () => 'x'}})).toThrow(
        'LangchainTool requires a name: the wrapped tool has none, so pass `name`.',
      );
    });
  });

  describe('returnDirect', () => {
    it('sets skipSummarization after a successful run', async () => {
      const context = makeContext();
      const adkTool = new LangchainTool({tool: makeReturnDirectTool('done')});

      await expect(
        adkTool.runAsync({args: {}, toolContext: context}),
      ).resolves.toEqual('done');
      expect(context.actions.skipSummarization).toBe(true);
    });

    it('sets skipSummarization when the result is null', async () => {
      const context = makeContext();
      const adkTool = new LangchainTool({tool: makeReturnDirectTool(null)});

      await adkTool.runAsync({args: {}, toolContext: context});

      expect(context.actions.skipSummarization).toBe(true);
    });

    it('sets skipSummarization for a result that carries an error key', async () => {
      const context = makeContext();
      const adkTool = new LangchainTool({
        tool: makeReturnDirectTool({error: 'boom'}),
      });

      await expect(
        adkTool.runAsync({args: {}, toolContext: context}),
      ).resolves.toEqual({error: 'boom'});
      expect(context.actions.skipSummarization).toBe(true);
    });

    it('leaves skipSummarization unset when the tool rejects', async () => {
      const context = makeContext();
      const rejectingTool = tool(() => 'unreachable', {
        name: 'strict',
        description: 'Rejects bad arguments',
        schema: z.object({x: z.number()}),
        returnDirect: true,
      });
      const adkTool = new LangchainTool({tool: rejectingTool});

      await expect(
        adkTool.runAsync({args: {x: 'not a number'}, toolContext: context}),
      ).rejects.toThrow("Error in tool 'strict'");
      expect(context.actions.skipSummarization).toBeUndefined();
    });

    it('leaves skipSummarization unset when the tool is not returnDirect', async () => {
      const context = makeContext();
      const adkTool = new LangchainTool({tool: makeAddTool()});

      await adkTool.runAsync({args: {x: 1, y: 1}, toolContext: context});

      expect(context.actions.skipSummarization).toBeUndefined();
    });
  });
});
