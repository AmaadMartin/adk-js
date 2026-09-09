/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  Context,
  createSession,
  FunctionTool,
  InvocationContext,
  isFunctionTool,
  LiveRequestQueue,
  PluginManager,
} from '@google/adk';
import {createUserContent, Type} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

describe('FunctionTool', () => {
  let emptyContext: Context;
  beforeEach(() => {
    emptyContext = {} as Context;
  });

  describe('isFunctionTool', () => {
    it('returns true for FunctionTool instances', () => {
      const tool = new FunctionTool({
        name: 'test',
        description: 'test',
        execute: () => {},
      });
      expect(isFunctionTool(tool)).toBe(true);
    });

    it('returns false for plain objects', () => {
      expect(isFunctionTool({})).toBe(false);
      expect(isFunctionTool({name: 'test'})).toBe(false);
    });

    it('returns false for null or undefined', () => {
      expect(isFunctionTool(null)).toBe(false);
      expect(isFunctionTool(undefined)).toBe(false);
    });
  });

  describe('zod v3', () => {
    it('computes the correct declaration', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });

      const declaration = addTool._getDeclaration();
      expect(declaration.name).toEqual('add');
      expect(declaration.description).toEqual('Adds two numbers.');
      expect(declaration.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          a: {type: Type.NUMBER},
          b: {type: Type.NUMBER},
        },
        required: ['a', 'b'],
      });
    });

    it('works with named functions', async () => {
      async function add({a, b}: {a: number; b: number}) {
        return a + b;
      }

      const addTool = new FunctionTool({
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
        }),
        execute: add,
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with lambda functions', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with a static method from a class', async () => {
      class Calculator {
        static add({a, b}: {a: number; b: number}) {
          return a + b;
        }
      }

      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
        }),
        execute: Calculator.add,
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with an stateful instance method from an object', async () => {
      class Counter {
        count = 0;
        incrementBy({a}: {a: number}) {
          this.count += a;
          return this.count;
        }
      }

      const counter = new Counter();
      const addTool = new FunctionTool({
        name: 'incrementBy',
        description: 'Increments a counter by the given number.',
        parameters: z3.object({a: z3.number()}),
        execute: counter.incrementBy.bind(counter),
      });

      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(1);
      expect(counter.count).toEqual(1);

      const result2 = await addTool.runAsync({
        args: {a: 2},
        toolContext: emptyContext,
      });
      expect(result2).toEqual(3);
      expect(counter.count).toEqual(3);
    });

    it('works with default values', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number().default(2),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with optional values', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number().optional(),
        }),
        execute: async ({a, b}) => {
          return b ? a + b : a;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(1);

      const result2 = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result2).toEqual(3);
    });

    it('works with array values', async () => {
      const concatStringTool = new FunctionTool({
        name: 'concat_string',
        description: 'Concatenates an array of strings.',
        parameters: z3.object({
          strings: z3.array(z3.string()),
        }),
        execute: async ({strings}) => {
          return strings.join(',');
        },
      });
      const result = await concatStringTool.runAsync({
        args: {strings: ['a', 'b', 'c']},
        toolContext: emptyContext,
      });
      expect(result).toEqual('a,b,c');
    });

    it('infers types from zod schema without explicit annotations', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('wraps errors from execute function', async () => {
      const tool = new FunctionTool({
        name: 'errorTool',
        description: 'Throws an error.',
        parameters: z4.object({}),
        execute: async () => {
          throw new Error('Test error');
        },
      });
      try {
        await tool.runAsync({
          args: {},
          toolContext: emptyContext,
        });
      } catch (e) {
        expect((e as Error).message).toContain(
          "Error in tool 'errorTool': Test error",
        );
      }
    });
  });

  describe('zod v4', () => {
    it('computes the correct declaration', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });

      const declaration = addTool._getDeclaration();
      expect(declaration.name).toEqual('add');
      expect(declaration.description).toEqual('Adds two numbers.');
      expect(declaration.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          a: {type: Type.NUMBER},
          b: {type: Type.NUMBER},
        },
        required: ['a', 'b'],
      });
    });

    it('works with named functions', async () => {
      async function add({a, b}: {a: number; b: number}) {
        return a + b;
      }

      const addTool = new FunctionTool({
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
        }),
        execute: add,
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with lambda functions', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with a static method from a class', async () => {
      class Calculator {
        static add({a, b}: {a: number; b: number}) {
          return a + b;
        }
      }

      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
        }),
        execute: Calculator.add,
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with an stateful instance method from an object', async () => {
      class Counter {
        count = 0;
        incrementBy({a}: {a: number}) {
          this.count += a;
          return this.count;
        }
      }

      const counter = new Counter();
      const addTool = new FunctionTool({
        name: 'incrementBy',
        description: 'Increments a counter by the given number.',
        parameters: z4.object({a: z4.number()}),
        execute: counter.incrementBy.bind(counter),
      });

      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(1);
      expect(counter.count).toEqual(1);

      const result2 = await addTool.runAsync({
        args: {a: 2},
        toolContext: emptyContext,
      });
      expect(result2).toEqual(3);
      expect(counter.count).toEqual(3);
    });

    it('works with default values', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number().default(2),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with optional values', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number().optional(),
        }),
        execute: async ({a, b}) => {
          return b ? a + b : a;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(1);

      const result2 = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result2).toEqual(3);
    });

    it('works with array values', async () => {
      const concatStringTool = new FunctionTool({
        name: 'concat_string',
        description: 'Concatenates an array of strings.',
        parameters: z4.object({
          strings: z4.array(z4.string()),
        }),
        execute: async ({strings}) => {
          return strings.join(',');
        },
      });
      const result = await concatStringTool.runAsync({
        args: {strings: ['a', 'b', 'c']},
        toolContext: emptyContext,
      });
      expect(result).toEqual('a,b,c');
    });

    it('infers types from zod schema without explicit annotations', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('wraps errors from execute function', async () => {
      const tool = new FunctionTool({
        name: 'errorTool',
        description: 'Throws an error.',
        parameters: z4.object({}),
        execute: async () => {
          throw new Error('Test error');
        },
      });
      try {
        await tool.runAsync({
          args: {},
          toolContext: emptyContext,
        });
      } catch (e) {
        expect((e as Error).message).toContain(
          "Error in tool 'errorTool': Test error",
        );
      }
    });
  });

  describe('input stream injection', () => {
    const STREAMING_TOOL_NAME = 'streaming_tool';

    function createToolContext(
      activeStreamingTools?: Record<string, ActiveStreamingTool>,
    ): Context {
      return new Context({
        invocationContext: new InvocationContext({
          invocationId: 'test-invocation',
          session: createSession({id: 'test-session', appName: 'test-app'}),
          pluginManager: new PluginManager([]),
          activeStreamingTools,
        }),
        functionCallId: 'test-function-call',
      });
    }

    it('passes the registered stream to execute and reads from it', async () => {
      const stream = new LiveRequestQueue();
      let received: LiveRequestQueue | undefined;
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Reads one request from the live input stream.',
        parameters: z4.object({}),
        execute: async (_input, _toolContext, inputStream) => {
          received = inputStream;
          if (!inputStream) {
            return 'no stream';
          }
          const request = await inputStream.get();
          return request.content?.parts?.[0]?.text;
        },
      });
      stream.send({content: createUserContent('hello')});

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext({
          [STREAMING_TOOL_NAME]: new ActiveStreamingTool({stream}),
        }),
      });

      expect(received).toBe(stream);
      expect(result).toEqual('hello');
    });

    it('passes undefined when the invocation registered no streaming tools', async () => {
      let received: LiveRequestQueue | undefined = new LiveRequestQueue();
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Records the third argument.',
        parameters: z4.object({}),
        execute: (_input, _toolContext, inputStream) => {
          received = inputStream;
          return 'done';
        },
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(received).toBeUndefined();
      expect(result).toEqual('done');
    });

    it('passes undefined when no stream is registered under this tool name', async () => {
      let received: LiveRequestQueue | undefined = new LiveRequestQueue();
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Records the third argument.',
        parameters: z4.object({}),
        execute: (_input, _toolContext, inputStream) => {
          received = inputStream;
          return 'done';
        },
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext({
          another_tool: new ActiveStreamingTool({
            stream: new LiveRequestQueue(),
          }),
        }),
      });

      expect(received).toBeUndefined();
      expect(result).toEqual('done');
    });

    it('passes undefined when the registered entry carries no stream', async () => {
      let received: LiveRequestQueue | undefined = new LiveRequestQueue();
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Records the third argument.',
        parameters: z4.object({}),
        execute: (_input, _toolContext, inputStream) => {
          received = inputStream;
          return 'done';
        },
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext({
          [STREAMING_TOOL_NAME]: new ActiveStreamingTool({}),
        }),
      });

      expect(received).toBeUndefined();
      expect(result).toEqual('done');
    });

    it('passes undefined when the tool context carries no invocation context', async () => {
      let received: LiveRequestQueue | undefined = new LiveRequestQueue();
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Records the third argument.',
        parameters: z4.object({}),
        execute: (_input, _toolContext, inputStream) => {
          received = inputStream;
          return 'done';
        },
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: emptyContext,
      });

      expect(received).toBeUndefined();
      expect(result).toEqual('done');
    });

    it('looks the stream up by the tool name, not the function name', async () => {
      const stream = new LiveRequestQueue();
      let received: LiveRequestQueue | undefined;
      function readLiveFeed(
        _input: Record<string, never>,
        _toolContext?: Context,
        inputStream?: LiveRequestQueue,
      ) {
        received = inputStream;
        return 'done';
      }
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Records the third argument.',
        parameters: z4.object({}),
        execute: readLiveFeed,
      });

      await tool.runAsync({
        args: {},
        toolContext: createToolContext({
          [STREAMING_TOOL_NAME]: new ActiveStreamingTool({stream}),
        }),
      });

      expect(received).toBe(stream);
    });

    it('leaves the arguments and the tool context untouched', async () => {
      const stream = new LiveRequestQueue();
      let receivedArgs: {a: number; b: number} | undefined;
      let receivedContext: Context | undefined;
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Records the first two arguments.',
        parameters: z4.object({a: z4.number(), b: z4.number().default(2)}),
        execute: (input, toolContext) => {
          receivedArgs = input;
          receivedContext = toolContext;
          return 'done';
        },
      });
      const toolContext = createToolContext({
        [STREAMING_TOOL_NAME]: new ActiveStreamingTool({stream}),
      });

      await tool.runAsync({args: {a: 1}, toolContext});

      expect(receivedArgs).toEqual({a: 1, b: 2});
      expect(receivedContext).toBe(toolContext);
    });

    it('keeps the input stream out of the declaration', () => {
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Reads the live input stream.',
        parameters: z4.object({language: z4.string()}),
        execute: (_input, _toolContext, _inputStream?: LiveRequestQueue) =>
          'done',
      });

      const declaration = tool._getDeclaration();

      expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
        'language',
      ]);
      expect(declaration.parameters?.required).toEqual(['language']);
    });

    it('does not report the missing stream as a missing argument', async () => {
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Reads the live input stream.',
        parameters: z4.object({language: z4.string()}),
        execute: (input, _toolContext, inputStream) =>
          inputStream ? input.language : 'no stream',
      });

      const result = await tool.runAsync({
        args: {language: 'en'},
        toolContext: createToolContext({
          [STREAMING_TOOL_NAME]: new ActiveStreamingTool({
            stream: new LiveRequestQueue(),
          }),
        }),
      });

      expect(result).toEqual('en');
    });

    it('does not pass the stream to the requireConfirmation predicate', async () => {
      const requireConfirmation = vi.fn(() => true);
      const execute = vi.fn(() => 'done');
      const tool = new FunctionTool({
        name: STREAMING_TOOL_NAME,
        description: 'Reads the live input stream.',
        parameters: z4.object({a: z4.number()}),
        requireConfirmation,
        execute,
      });
      const toolContext = createToolContext({
        [STREAMING_TOOL_NAME]: new ActiveStreamingTool({
          stream: new LiveRequestQueue(),
        }),
      });

      const result = await tool.runAsync({args: {a: 1}, toolContext});

      expect(requireConfirmation).toHaveBeenCalledWith({a: 1}, toolContext);
      expect(execute).not.toHaveBeenCalled();
      expect(result).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
    });
  });
});
