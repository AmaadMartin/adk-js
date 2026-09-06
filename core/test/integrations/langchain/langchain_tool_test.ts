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
import {RunnableConfig} from '@langchain/core/runnables';
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

    it('carries the constraints of a Zod object into the declaration', () => {
      const bookTool = tool(({name}: {name: string}) => name, {
        name: 'book',
        description: 'Books a name against a tag list',
        schema: z.object({
          name: z.string().min(3).max(9),
          tags: z.array(z.string()).min(1).max(4),
        }),
      });
      const adkTool = new LangchainTool({tool: bookTool});

      expect(adkTool._getDeclaration().parameters?.properties).toEqual({
        name: {type: Type.STRING, minLength: '3', maxLength: '9'},
        tags: {
          type: Type.ARRAY,
          items: {type: Type.STRING},
          minItems: '1',
          maxItems: '4',
        },
      });
    });

    it('declares a defaulted field as optional', async () => {
      const greetTool = tool(
        ({name, greeting}: {name: string; greeting: string}) =>
          `${greeting}, ${name}`,
        {
          name: 'greet_default',
          description: 'Greets someone',
          schema: z.object({
            name: z.string(),
            greeting: z.string().default('hello'),
          }),
        },
      );
      const adkTool = new LangchainTool({tool: greetTool});

      expect(adkTool._getDeclaration().parameters?.required).toEqual(['name']);
      await expect(
        adkTool.runAsync({args: {name: 'ada'}, toolContext: emptyContext}),
      ).resolves.toEqual('hello, ada');
    });

    it('declares a transformed field by the value it accepts', async () => {
      const splitTool = tool(({items}: {items: string[]}) => items.length, {
        name: 'count',
        description: 'Counts comma-separated items',
        schema: z.object({
          items: z.string().transform((value) => value.split(',')),
        }),
      });
      const adkTool = new LangchainTool({tool: splitTool});

      expect(adkTool._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {items: {type: Type.STRING}},
        required: ['items'],
      });
      await expect(
        adkTool.runAsync({args: {items: 'a,b,c'}, toolContext: emptyContext}),
      ).resolves.toEqual(3);
    });

    it('renders the input side of a transformed object schema', async () => {
      const upperTool = tool((word: string) => word.toUpperCase(), {
        name: 'upper',
        description: 'Uppercases a word',
        schema: z.object({word: z.string()}).transform(({word}) => word),
      });
      const adkTool = new LangchainTool({tool: upperTool});

      expect(adkTool._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {word: {type: Type.STRING}},
        required: ['word'],
      });
      await expect(
        adkTool.runAsync({args: {word: 'hi'}, toolContext: emptyContext}),
      ).resolves.toEqual('HI');
    });

    it('reports a Zod type it cannot render', () => {
      expect(
        () =>
          new LangchainTool({
            tool: {
              name: 'dated',
              invoke: () => 'x',
              schema: z.object({when: z.date()}),
            },
          }),
      ).toThrow(
        /^Failed to build function declaration for Langchain tool: .*Date/,
      );
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

    it('calls the wrapped invoke with the arguments alone', async () => {
      const calls: unknown[][] = [];
      const adkTool = new LangchainTool({
        tool: {
          name: 'arity',
          invoke(...args: unknown[]) {
            calls.push(args);
            return 'ok';
          },
        },
      });

      await adkTool.runAsync({args: {x: 1}, toolContext: emptyContext});

      expect(calls).toEqual([[{x: 1}]]);
    });

    it('keeps the ADK context out of the LangChain tool config', async () => {
      let seenConfig: RunnableConfig | undefined;
      const probe = tool(
        (_input: {x: number}, config?: RunnableConfig) => {
          seenConfig = config;
          return 'ok';
        },
        {
          name: 'probe',
          description: 'Records the config it receives',
          schema: z.object({x: z.number()}),
        },
      );
      const adkTool = new LangchainTool({tool: probe});
      const contextKeys = Object.keys(emptyContext);

      await adkTool.runAsync({args: {x: 1}, toolContext: emptyContext});

      if (!seenConfig) {
        expect.fail('the wrapped tool received no config');
      }
      expect(contextKeys).not.toHaveLength(0);
      const leaked = Object.keys(seenConfig).filter((key) =>
        contextKeys.includes(key),
      );
      expect(leaked).toEqual([]);
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

    it('reports the missing invoke before the missing name', () => {
      expect(() => new LangchainTool({tool: {}})).toThrow(
        "Tool must be a LangChain tool with an 'invoke' method.",
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

    it('leaves skipSummarization unset for a truthy error payload', async () => {
      const context = makeContext();
      const adkTool = new LangchainTool({
        tool: makeReturnDirectTool({error: 'boom'}),
      });

      await expect(
        adkTool.runAsync({args: {}, toolContext: context}),
      ).resolves.toEqual({error: 'boom'});
      expect(context.actions.skipSummarization).toBeUndefined();
    });

    it('sets skipSummarization for a falsy error key', async () => {
      const context = makeContext();
      const adkTool = new LangchainTool({
        tool: makeReturnDirectTool({error: null, value: 1}),
      });

      await expect(
        adkTool.runAsync({args: {}, toolContext: context}),
      ).resolves.toEqual({error: null, value: 1});
      expect(context.actions.skipSummarization).toBe(true);
    });

    it('sets skipSummarization for an array result', async () => {
      const context = makeContext();
      const adkTool = new LangchainTool({tool: makeReturnDirectTool([1, 2])});

      await expect(
        adkTool.runAsync({args: {}, toolContext: context}),
      ).resolves.toEqual([1, 2]);
      expect(context.actions.skipSummarization).toBe(true);
    });

    it('sets skipSummarization for an object with no error key', async () => {
      const context = makeContext();
      const adkTool = new LangchainTool({
        tool: makeReturnDirectTool({value: 1}),
      });

      await adkTool.runAsync({args: {}, toolContext: context});

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
