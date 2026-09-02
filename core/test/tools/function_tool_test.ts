/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  Context,
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  PluginManager,
  createSession,
  isFunctionTool,
} from '@google/adk';
import {
  FunctionResponseScheduling,
  Schema,
  Type,
  createUserContent,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

/** The message adk-python returns when mandatory arguments are absent. */
function missingArgsError(name: string, missing: string[]) {
  return {
    error:
      `Invoking \`${name}()\` failed as the following mandatory input parameters are not present:\n` +
      `${missing.join('\n')}\n` +
      'You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.',
  };
}

/** A tool context backed by a real invocation, so `actions` is observable. */
function makeContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
      session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
      pluginManager: new PluginManager([]),
    }),
    functionCallId: 'fc-1',
  });
}

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

  describe('missing mandatory arguments, zod v3', () => {
    it('returns the retry error and leaves the tool unrun', async () => {
      let ran = false;
      const tool = new FunctionTool({
        name: 'send_email',
        description: 'Sends an email.',
        parameters: z3.object({to: z3.string(), subject: z3.string()}),
        execute: () => {
          ran = true;
          return 'sent';
        },
      });

      const result = await tool.runAsync({
        args: {to: 'a@b.c'},
        toolContext: emptyContext,
      });

      expect(result).toEqual({
        error:
          'Invoking `send_email()` failed as the following mandatory input parameters are not present:\n' +
          'subject\n' +
          'You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.',
      });
      expect(ran).toBe(false);
    });

    it('names three absent parameters in declaration order', async () => {
      const tool = new FunctionTool({
        name: 'plan_trip',
        description: 'Plans a trip.',
        parameters: z3.object({
          origin: z3.string(),
          destination: z3.string(),
          departure: z3.string(),
          budget: z3.number(),
        }),
        execute: () => 'planned',
      });

      const result = await tool.runAsync({
        args: {destination: 'Rome'},
        toolContext: emptyContext,
      });

      expect(result).toEqual(
        missingArgsError('plan_trip', ['origin', 'departure', 'budget']),
      );
    });

    it('names every parameter when the call carries none', async () => {
      const tool = new FunctionTool({
        name: 'plan_trip',
        description: 'Plans a trip.',
        parameters: z3.object({
          origin: z3.string(),
          destination: z3.string(),
          departure: z3.string(),
          budget: z3.number(),
        }),
        execute: () => 'planned',
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: emptyContext,
      });

      expect(result).toEqual(
        missingArgsError('plan_trip', [
          'origin',
          'destination',
          'departure',
          'budget',
        ]),
      );
    });

    it('declares neither a defaulted nor an optional parameter as required', () => {
      const tool = new FunctionTool({
        name: 'add',
        description: 'Adds numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number().default(2),
          c: z3.number().optional(),
        }),
        execute: ({a, b, c}) => a + b + (c ?? 0),
      });

      expect(tool._getDeclaration().parameters?.required).toEqual(['a']);
    });
  });

  describe('missing mandatory arguments, zod v4', () => {
    it('returns the retry error and leaves the tool unrun', async () => {
      let ran = false;
      const tool = new FunctionTool({
        name: 'send_email',
        description: 'Sends an email.',
        parameters: z4.object({to: z4.string(), subject: z4.string()}),
        execute: () => {
          ran = true;
          return 'sent';
        },
      });

      const result = await tool.runAsync({
        args: {to: 'a@b.c'},
        toolContext: emptyContext,
      });

      expect(result).toEqual(missingArgsError('send_email', ['subject']));
      expect(ran).toBe(false);
    });

    it('names three absent parameters in declaration order', async () => {
      const tool = new FunctionTool({
        name: 'plan_trip',
        description: 'Plans a trip.',
        parameters: z4.object({
          origin: z4.string(),
          destination: z4.string(),
          departure: z4.string(),
          budget: z4.number(),
        }),
        execute: () => 'planned',
      });

      const result = await tool.runAsync({
        args: {destination: 'Rome'},
        toolContext: emptyContext,
      });

      expect(result).toEqual(
        missingArgsError('plan_trip', ['origin', 'departure', 'budget']),
      );
    });

    it('names every parameter when the call carries none', async () => {
      const tool = new FunctionTool({
        name: 'plan_trip',
        description: 'Plans a trip.',
        parameters: z4.object({
          origin: z4.string(),
          destination: z4.string(),
          departure: z4.string(),
          budget: z4.number(),
        }),
        execute: () => 'planned',
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: emptyContext,
      });

      expect(result).toEqual(
        missingArgsError('plan_trip', [
          'origin',
          'destination',
          'departure',
          'budget',
        ]),
      );
    });

    it('declares neither a defaulted nor an optional parameter as required', () => {
      const tool = new FunctionTool({
        name: 'add',
        description: 'Adds numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number().default(2),
          c: z4.number().optional(),
        }),
        execute: ({a, b, c}) => a + b + (c ?? 0),
      });

      expect(tool._getDeclaration().parameters?.required).toEqual(['a']);
    });
  });

  describe('missing mandatory arguments, raw schema', () => {
    it('returns the retry error for a schema-declared tool', async () => {
      let ran = false;
      const tool = new FunctionTool({
        name: 'send_email',
        description: 'Sends an email.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            to: {type: Type.STRING},
            subject: {type: Type.STRING},
          },
          required: ['to', 'subject'],
        },
        execute: () => {
          ran = true;
          return 'sent';
        },
      });

      const result = await tool.runAsync({
        args: {subject: 'hi'},
        toolContext: emptyContext,
      });

      expect(result).toEqual(missingArgsError('send_email', ['to']));
      expect(ran).toBe(false);
    });

    it('runs the tool once every required key is present', async () => {
      const tool = new FunctionTool({
        name: 'send_email',
        description: 'Sends an email.',
        parameters: {
          type: Type.OBJECT,
          properties: {to: {type: Type.STRING}},
          required: ['to'],
        },
        execute: () => 'sent',
      });

      const result = await tool.runAsync({
        args: {to: 'a@b.c'},
        toolContext: emptyContext,
      });

      expect(result).toBe('sent');
    });
  });

  describe('mandatory argument gate ordering', () => {
    it('rejects a required argument of the wrong type', async () => {
      const tool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({a: z3.number(), b: z3.number()}),
        execute: ({a, b}) => a + b,
      });

      await expect(
        tool.runAsync({args: {a: 'x', b: 2}, toolContext: emptyContext}),
      ).rejects.toThrow("Error in tool 'add':");
    });

    it('answers a missing argument before requesting confirmation', async () => {
      let ran = false;
      const tool = new FunctionTool({
        name: 'delete_file',
        description: 'Deletes a file.',
        parameters: z3.object({path: z3.string()}),
        execute: () => {
          ran = true;
          return 'deleted';
        },
        requireConfirmation: true,
      });
      const ctx = makeContext();

      const result = await tool.runAsync({args: {}, toolContext: ctx});

      expect(result).toEqual(missingArgsError('delete_file', ['path']));
      expect(ctx.actions.requestedToolConfirmations).toEqual({});
      expect(ran).toBe(false);
    });
  });

  describe('undeclared arguments', () => {
    it('drops keys a raw schema does not declare', async () => {
      let received: unknown;
      const tool = new FunctionTool({
        name: 'echo',
        description: 'Echoes the expected argument.',
        parameters: {
          type: Type.OBJECT,
          properties: {expectedArg: {type: Type.STRING}},
          required: ['expectedArg'],
        },
        execute: (input) => {
          received = input;
          return 'ok';
        },
      });

      await tool.runAsync({
        args: {expectedArg: 'hello', parameters: 'should_be_filtered'},
        toolContext: emptyContext,
      });

      expect(received).toEqual({expectedArg: 'hello'});
    });

    it('keeps every key when a raw schema declares no properties', async () => {
      let received: unknown;
      const tool = new FunctionTool({
        name: 'echo',
        description: 'Echoes whatever it is given.',
        parameters: {type: Type.OBJECT},
        execute: (input) => {
          received = input;
          return 'ok';
        },
      });

      await tool.runAsync({
        args: {anything: 1, more: 2},
        toolContext: emptyContext,
      });

      expect(received).toEqual({anything: 1, more: 2});
    });

    it('drops keys a zod object does not declare', async () => {
      let received: unknown;
      const tool = new FunctionTool({
        name: 'echo',
        description: 'Echoes the expected argument.',
        parameters: z3.object({expectedArg: z3.string()}),
        execute: (input) => {
          received = input;
          return 'ok';
        },
      });

      await tool.runAsync({
        args: {expectedArg: 'hello', parameters: 'should_be_filtered'},
        toolContext: emptyContext,
      });

      expect(received).toEqual({expectedArg: 'hello'});
    });

    it('keeps every key when the tool declares no parameters', async () => {
      let received: unknown;
      const tool = new FunctionTool({
        name: 'echo',
        description: 'Echoes whatever it is given.',
        execute: (input) => {
          received = input;
          return 'ok';
        },
      });

      await tool.runAsync({
        args: {responseType: 'error', errorType: 'timeout'},
        toolContext: emptyContext,
      });

      expect(received).toEqual({responseType: 'error', errorType: 'timeout'});
    });
  });

  describe('raw schema argument parsing', () => {
    /** A tool that records the arguments its `execute` receives. */
    function recordingTool(parameters: Schema) {
      const calls: unknown[] = [];
      const tool = new FunctionTool({
        name: 'measure',
        description: 'Records what it is called with.',
        parameters,
        execute: (input) => {
          calls.push(input);
          return 'ok';
        },
      });
      return {tool, calls};
    }

    const countSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        count: {type: Type.INTEGER},
        unit: {type: Type.STRING, default: 'items'},
      },
      required: ['count'],
    };

    it('applies a schema default the model did not supply', async () => {
      const {tool, calls} = recordingTool(countSchema);

      await tool.runAsync({args: {count: 3}, toolContext: emptyContext});

      expect(calls).toEqual([{count: 3, unit: 'items'}]);
    });

    it('passes arguments that violate the schema through unparsed', async () => {
      const {tool, calls} = recordingTool(countSchema);

      const result = await tool.runAsync({
        args: {count: '3'},
        toolContext: emptyContext,
      });

      expect(result).toBe('ok');
      expect(calls).toEqual([{count: '3'}]);
    });

    it('leaves arguments untouched when the schema has no Zod equivalent', async () => {
      const {tool, calls} = recordingTool({type: Type.TYPE_UNSPECIFIED});

      await tool.runAsync({
        args: {count: '3', extra: true},
        toolContext: emptyContext,
      });

      expect(calls).toEqual([{count: '3', extra: true}]);
    });

    it('still rejects arguments that violate a zod object', async () => {
      const tool = new FunctionTool({
        name: 'measure',
        description: 'Counts things.',
        parameters: z3.object({count: z3.number()}),
        execute: () => 'ok',
      });

      await expect(
        tool.runAsync({args: {count: '3'}, toolContext: emptyContext}),
      ).rejects.toThrow("Error in tool 'measure'");
    });
  });

  describe('_getDeclaration copies', () => {
    it('hands each caller an independent copy', () => {
      const tool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({a: z3.number(), b: z3.number()}),
        execute: ({a, b}) => a + b,
      });

      const first = tool._getDeclaration();
      const second = tool._getDeclaration();
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(first.parameters).not.toBe(second.parameters);

      const parameters = first.parameters;
      if (!parameters?.properties) {
        expect.fail('the declaration should carry object properties');
      }
      first.name = 'prefixed_add';
      parameters.properties['a'] = {type: Type.STRING, description: 'mutated'};

      const third = tool._getDeclaration();
      expect(third.name).toBe('add');
      expect(third.parameters).toEqual(second.parameters);
    });

    it('never exposes the raw schema the caller supplied', () => {
      const parameters: Schema = {
        type: Type.OBJECT,
        properties: {a: {type: Type.STRING}},
        required: ['a'],
      };
      const tool = new FunctionTool({
        name: 'echo',
        description: 'Echoes.',
        parameters,
        execute: () => 'ok',
      });

      const declared = tool._getDeclaration().parameters;
      if (!declared?.properties) {
        expect.fail('the declaration should carry object properties');
      }
      declared.properties['a'] = {type: Type.NUMBER};
      declared.required = [];

      expect(parameters.properties).toEqual({a: {type: Type.STRING}});
      expect(parameters.required).toEqual(['a']);
      expect(tool._getDeclaration().parameters).toEqual(parameters);
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

  describe('responseScheduling', () => {
    it('forwards responseScheduling to the tool', () => {
      const tool = new FunctionTool({
        name: 'my_tool',
        description: 'Does something.',
        execute: async () => 'done',
        responseScheduling: FunctionResponseScheduling.WHEN_IDLE,
      });

      expect(tool.responseScheduling).toBe(
        FunctionResponseScheduling.WHEN_IDLE,
      );
    });

    it('leaves responseScheduling undefined by default', () => {
      const tool = new FunctionTool({
        name: 'my_tool',
        description: 'Does something.',
        execute: async () => 'done',
      });

      expect(tool.responseScheduling).toBeUndefined();
    });
  });
});

describe('FunctionTool.detectErrorInResponse', () => {
  const tool = new FunctionTool({
    name: 'echo',
    description: 'Echoes.',
    execute: () => 'ok',
  });

  it('reports TOOL_ERROR for a response carrying a truthy error', () => {
    expect(tool.detectErrorInResponse({error: 'missing arg'})).toBe(
      'TOOL_ERROR',
    );
  });

  it.each([
    ['a clean result object', {result: 'ok'}],
    ['an empty error message', {error: ''}],
    ['a zero error code', {error: 0}],
    ['a plain string', 'plain string'],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
  ])('reports no error type for %s', (_name, response) => {
    expect(tool.detectErrorInResponse(response)).toBeUndefined();
  });
});
