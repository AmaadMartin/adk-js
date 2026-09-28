/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  CrewaiTool,
  CrewaiToolLike,
  InvocationContext,
  isBaseTool,
  isFunctionTool,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

/** The args schema the Python reference test uses, as plain JSON Schema. */
const SEARCH_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    search_query: {type: 'string', description: 'Search query'},
  },
};

function createContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

/** A CrewAI-style tool that echoes back what it received. */
function createEchoTool(overrides: Partial<CrewaiToolLike> = {}) {
  const calls: Array<{args: unknown; context?: Context}> = [];
  const tool: CrewaiToolLike = {
    name: 'mock_tool',
    description: 'Mock tool',
    argsSchema: SEARCH_QUERY_SCHEMA,
    run(args: unknown, context?: Context) {
      calls.push({args, context});
      return args;
    },
    ...overrides,
  };
  return {tool, calls};
}

describe('CrewaiTool', () => {
  describe('construction', () => {
    it('uses the explicit name and description', () => {
      const {tool} = createEchoTool();

      const crewaiTool = new CrewaiTool({
        tool,
        name: 'custom_search_tool',
        description: 'Custom search tool description',
      });

      expect(crewaiTool.name).toBe('custom_search_tool');
      expect(crewaiTool.description).toBe('Custom search tool description');
    });

    it("falls back to the wrapped tool's name and description", () => {
      const {tool} = createEchoTool({
        name: 'Serper Dev Tool',
        description: 'Search the internet with Serper',
      });

      const crewaiTool = new CrewaiTool({tool});

      expect(crewaiTool.name).toBe('serper_dev_tool');
      expect(crewaiTool.description).toBe('Search the internet with Serper');
    });

    it('replaces every space in the fallback name', () => {
      const {tool} = createEchoTool({name: 'a b c'});

      expect(new CrewaiTool({tool}).name).toBe('a_b_c');
    });

    it('leaves an explicit name unchanged', () => {
      const {tool} = createEchoTool({name: 'Serper Dev Tool'});

      expect(new CrewaiTool({tool, name: 'My Tool'}).name).toBe('My Tool');
    });

    it('describes the tool as empty when neither side has a description', () => {
      const {tool} = createEchoTool({description: undefined});

      expect(new CrewaiTool({tool}).description).toBe('');
    });

    it('throws when the wrapped value has no run method', () => {
      expect(() => new CrewaiTool({tool: {name: 'x'}})).toThrow(
        "Tool must be a CrewAI tool with a 'run' method.",
      );
    });

    it('throws when no name can be resolved', () => {
      const {tool} = createEchoTool({name: undefined});

      expect(() => new CrewaiTool({tool})).toThrow(
        'CrewaiTool requires a name: the wrapped tool has none, so pass `name`.',
      );
    });

    it('throws when the args schema is neither Zod nor a JSON object', () => {
      const {tool} = createEchoTool({argsSchema: 'nope'});

      expect(() => new CrewaiTool({tool})).toThrow(
        'Failed to build function declaration for CrewAI tool: unsupported schema of type string',
      );
    });

    it('is recognised by the tool type guards', () => {
      const {tool} = createEchoTool();

      const crewaiTool = new CrewaiTool({tool});

      expect(isBaseTool(crewaiTool)).toBe(true);
      expect(isFunctionTool(crewaiTool)).toBe(true);
    });

    it('is accepted as a tool of an LlmAgent', async () => {
      const {tool} = createEchoTool({name: 'Serper Dev Tool'});

      const agent = new LlmAgent({
        name: 'researcher',
        model: 'gemini-2.5-flash',
        tools: [new CrewaiTool({tool})],
      });

      const tools = await agent.canonicalTools();
      expect(tools.map((each) => each.name)).toEqual(['serper_dev_tool']);
    });
  });

  describe('declaration', () => {
    it('derives the parameters from the args schema', () => {
      const {tool} = createEchoTool();

      const declaration = new CrewaiTool({
        tool,
        name: 'test_tool',
        description: 'Test tool',
      })._getDeclaration();

      expect(declaration.name).toBe('test_tool');
      expect(declaration.description).toBe('Test tool');
      expect(declaration.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          search_query: {type: Type.STRING, description: 'Search query'},
        },
        required: [],
      });
    });

    it('accepts a Zod args schema', () => {
      const {tool} = createEchoTool({
        argsSchema: z.object({query: z.string()}),
      });

      const declaration = new CrewaiTool({tool})._getDeclaration();

      expect(declaration.parameters).toEqual({
        type: Type.OBJECT,
        properties: {query: {type: Type.STRING}},
        required: ['query'],
      });
    });

    it('declares empty parameters when the schema has no properties', () => {
      const {tool} = createEchoTool({argsSchema: {type: 'object'}});

      expect(new CrewaiTool({tool})._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {},
        required: [],
      });
    });

    it('declares empty parameters when the tool has no args schema', () => {
      const {tool} = createEchoTool({argsSchema: undefined});

      expect(new CrewaiTool({tool})._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {},
      });
    });
  });

  describe('runAsync', () => {
    it('passes every model argument through to run', async () => {
      const {tool, calls} = createEchoTool();
      const crewaiTool = new CrewaiTool({tool, name: 'test_tool'});

      const result = await crewaiTool.runAsync({
        args: {search_query: 'test query', other_param: 'test value'},
        toolContext: createContext(),
      });

      expect(result).toEqual({
        search_query: 'test query',
        other_param: 'test value',
      });
      expect(calls).toHaveLength(1);
    });

    it('forwards the ADK context as the second argument', async () => {
      const {tool, calls} = createEchoTool();
      const crewaiTool = new CrewaiTool({tool, name: 'test_tool'});
      const toolContext = createContext();

      await crewaiTool.runAsync({args: {search_query: 'q'}, toolContext});

      expect(calls[0].context).toBe(toolContext);
    });

    it('strips the framework-reserved arguments', async () => {
      const {tool, calls} = createEchoTool();
      const crewaiTool = new CrewaiTool({tool, name: 'test_tool'});
      const toolContext = createContext();

      await crewaiTool.runAsync({
        args: {
          search_query: 'q',
          self: 'spoofed',
          tool_context: 'spoofed',
          toolContext: 'spoofed',
        },
        toolContext,
      });

      expect(calls[0].args).toEqual({search_query: 'q'});
      expect(calls[0].context).toBe(toolContext);
    });

    it("does not mutate the caller's arguments", async () => {
      const {tool} = createEchoTool();
      const crewaiTool = new CrewaiTool({tool, name: 'test_tool'});
      const args = {search_query: 'q', self: 'spoofed'};

      await crewaiTool.runAsync({args, toolContext: createContext()});

      expect(args).toEqual({search_query: 'q', self: 'spoofed'});
    });

    it('calls run on the wrapped tool', async () => {
      const wrapped = {
        name: 'bound_tool',
        marker: 'from the wrapped tool',
        run(this: {marker: string}) {
          return this.marker;
        },
      };

      const result = await new CrewaiTool({tool: wrapped}).runAsync({
        args: {},
        toolContext: createContext(),
      });

      expect(result).toBe('from the wrapped tool');
    });

    it('awaits an asynchronous run', async () => {
      const {tool} = createEchoTool({
        run: async () => 'resolved value',
      });

      const result = await new CrewaiTool({tool}).runAsync({
        args: {search_query: 'q'},
        toolContext: createContext(),
      });

      expect(result).toBe('resolved value');
    });

    it('returns a retry hint when a mandatory argument is missing', async () => {
      const run = vi.fn(() => 'never');
      const {tool} = createEchoTool({
        argsSchema: z.object({query: z.string(), topic: z.string()}),
        run,
      });
      const crewaiTool = new CrewaiTool({tool, name: 'search'});

      const result = await crewaiTool.runAsync({
        args: {},
        toolContext: createContext(),
      });

      expect(result).toEqual({
        error:
          'Invoking `search()` failed as the following mandatory input parameters are not present:\n' +
          'query\ntopic\n' +
          'You could retry calling this tool, but it is IMPORTANT for you to ' +
          'provide all the mandatory parameters.',
      });
      expect(run).not.toHaveBeenCalled();
    });

    it('runs when every mandatory argument is present', async () => {
      const {tool, calls} = createEchoTool({
        argsSchema: z.object({query: z.string()}),
      });

      const result = await new CrewaiTool({tool, name: 'search'}).runAsync({
        args: {query: 'q'},
        toolContext: createContext(),
      });

      expect(result).toEqual({query: 'q'});
      expect(calls).toHaveLength(1);
    });

    it('ignores a non-array required field in the args schema', async () => {
      const {tool, calls} = createEchoTool({
        argsSchema: {type: 'object', required: 'query'},
      });

      await new CrewaiTool({tool, name: 'search'}).runAsync({
        args: {},
        toolContext: createContext(),
      });

      expect(calls).toHaveLength(1);
    });

    it("wraps an error thrown by the wrapped tool with the tool's name", async () => {
      const {tool} = createEchoTool({
        run: () => {
          throw new Error('upstream failure');
        },
      });

      await expect(
        new CrewaiTool({tool, name: 'search'}).runAsync({
          args: {},
          toolContext: createContext(),
        }),
      ).rejects.toThrow("Error in tool 'search': upstream failure");
    });
  });
});
