/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  CrewaiBaseTool,
  CrewaiTool,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {FunctionResponse, Type} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ScriptedLlm} from '../workflow/test_helpers.js';

const ARGS_SCHEMA: NonNullable<CrewaiBaseTool['argsSchema']> = {
  type: 'object',
  properties: {
    search_query: {type: 'string', description: 'Search query'},
  },
  required: ['search_query'],
};

/** Builds a CrewAI-shaped tool whose `run` records how it was called. */
function createCrewaiTool(
  overrides: Partial<CrewaiBaseTool> = {},
): CrewaiBaseTool {
  return {
    name: 'mock_tool',
    description: 'Mock tool',
    argsSchema: ARGS_SCHEMA,
    run: vi.fn((args: Record<string, unknown>) => ({echoed: args})),
    ...overrides,
  };
}

describe('CrewaiTool', () => {
  let emptyContext: Context;

  beforeEach(() => {
    emptyContext = {} as Context;
  });

  describe('construction', () => {
    it('prefers the explicit name and description, and keeps the wrapped tool', () => {
      const crewaiTool = createCrewaiTool();

      const tool = new CrewaiTool(crewaiTool, {
        name: 'custom_search_tool',
        description: 'Custom search tool description',
      });

      expect(tool.name).toBe('custom_search_tool');
      expect(tool.description).toBe('Custom search tool description');
      expect(tool.tool).toBe(crewaiTool);
    });

    it("normalises the wrapped tool's display name when no name is given", () => {
      const tool = new CrewaiTool(
        createCrewaiTool({
          name: 'Serper Dev Tool',
          description: 'Search the internet with Serper',
        }),
      );

      expect(tool.name).toBe('serper_dev_tool');
      expect(tool.description).toBe('Search the internet with Serper');
    });

    it('does not normalise an explicitly provided name', () => {
      const tool = new CrewaiTool(createCrewaiTool({name: 'Serper Dev Tool'}), {
        name: 'Keep This Name',
      });

      expect(tool.name).toBe('Keep This Name');
    });

    it('replaces every space in the display name, not just the first', () => {
      const tool = new CrewaiTool(createCrewaiTool({name: 'A  B Tool'}));

      expect(tool.name).toBe('a__b_tool');
    });

    it('falls back to an empty description when neither source has one', () => {
      const tool = new CrewaiTool(createCrewaiTool({description: ''}));

      expect(tool.description).toBe('');
    });

    it('throws when neither the options nor the tool supply a name', () => {
      expect(() => new CrewaiTool(createCrewaiTool({name: ''}))).toThrow(
        'Tool name cannot be empty. Either provide a `name` option or set a name on the CrewAI tool.',
      );
    });
  });

  describe('_getDeclaration', () => {
    it('declares the argument schema as gemini parameters', () => {
      const tool = new CrewaiTool(createCrewaiTool(), {
        name: 'test_tool',
        description: 'Test tool',
      });

      const declaration = tool._getDeclaration();

      expect(declaration.name).toBe('test_tool');
      expect(declaration.description).toBe('Test tool');
      expect(declaration.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          search_query: {type: Type.STRING, description: 'Search query'},
        },
        required: ['search_query'],
      });
    });

    it('omits the parameters when the tool declares no argument schema', () => {
      const tool = new CrewaiTool(createCrewaiTool({argsSchema: undefined}));

      expect(tool._getDeclaration().parameters).toBeUndefined();
    });

    it('omits the parameters when the argument schema has no properties', () => {
      const tool = new CrewaiTool(
        createCrewaiTool({argsSchema: {type: 'object', properties: {}}}),
      );

      expect(tool._getDeclaration().parameters).toBeUndefined();
    });
  });

  describe('runAsync', () => {
    it('forwards the model arguments verbatim and returns the result', async () => {
      const crewaiTool = createCrewaiTool();
      const tool = new CrewaiTool(crewaiTool, {name: 'test_tool'});

      const result = await tool.runAsync({
        args: {search_query: 'test query', other_param: 'test value'},
        toolContext: emptyContext,
      });

      expect(crewaiTool.run).toHaveBeenCalledWith(
        {search_query: 'test query', other_param: 'test value'},
        emptyContext,
      );
      expect(result).toEqual({
        echoed: {search_query: 'test query', other_param: 'test value'},
      });
    });

    it('passes the ADK context as the second argument', async () => {
      const crewaiTool = createCrewaiTool({
        run: (_args: Record<string, unknown>, toolContext?: Context) => ({
          contextPresent: toolContext === emptyContext,
        }),
      });
      const tool = new CrewaiTool(crewaiTool, {name: 'context_tool'});

      const result = await tool.runAsync({
        args: {search_query: 'test query'},
        toolContext: emptyContext,
      });

      expect(result).toEqual({contextPresent: true});
    });

    it('strips a model-supplied tool_context argument', async () => {
      const crewaiTool = createCrewaiTool();
      const tool = new CrewaiTool(crewaiTool, {name: 'test_tool'});

      await tool.runAsync({
        args: {search_query: 'test query', tool_context: 'hallucinated'},
        toolContext: emptyContext,
      });

      expect(crewaiTool.run).toHaveBeenCalledWith(
        {search_query: 'test query'},
        emptyContext,
      );
    });

    it('does not mutate the caller-supplied arguments', async () => {
      const args = {search_query: 'test query', tool_context: 'hallucinated'};
      const tool = new CrewaiTool(createCrewaiTool(), {name: 'test_tool'});

      await tool.runAsync({args, toolContext: emptyContext});

      expect(args).toEqual({
        search_query: 'test query',
        tool_context: 'hallucinated',
      });
    });

    it('awaits an asynchronous run', async () => {
      const crewaiTool = createCrewaiTool({
        run: async () => 'async result',
      });
      const tool = new CrewaiTool(crewaiTool, {name: 'async_tool'});

      await expect(
        tool.runAsync({args: {}, toolContext: emptyContext}),
      ).resolves.toBe('async result');
    });

    it('returns the value of a synchronous run', async () => {
      const crewaiTool = createCrewaiTool({run: () => 'sync result'});
      const tool = new CrewaiTool(crewaiTool, {name: 'sync_tool'});

      await expect(
        tool.runAsync({args: {}, toolContext: emptyContext}),
      ).resolves.toBe('sync result');
    });

    it('propagates an error from the wrapped tool unwrapped', async () => {
      const crewaiTool = createCrewaiTool({
        run: () => {
          throw new Error('crewai failure');
        },
      });
      const tool = new CrewaiTool(crewaiTool, {name: 'failing_tool'});

      await expect(
        tool.runAsync({args: {}, toolContext: emptyContext}),
      ).rejects.toThrow('crewai failure');
    });
  });

  describe('in an agent run', () => {
    it('runs the wrapped tool when the model calls its normalised name', async () => {
      const queries: string[] = [];
      const crewaiTool = createCrewaiTool({
        name: 'Serper Dev Tool',
        description: 'Search the internet with Serper',
        run: (args: Record<string, unknown>) => {
          queries.push(String(args['search_query']));
          return {results: ['adk-js']};
        },
      });
      const agent = new LlmAgent({
        name: 'researcher',
        model: new ScriptedLlm([
          {
            functionCall: {
              name: 'serper_dev_tool',
              args: {search_query: 'what is adk'},
            },
          },
          {text: 'adk-js'},
        ]),
        tools: [new CrewaiTool(crewaiTool)],
      });
      const sessionService = new InMemorySessionService();
      const session = await sessionService.createSession({
        appName: 'crewai_app',
        userId: 'u1',
      });
      const runner = new Runner({
        appName: 'crewai_app',
        agent,
        sessionService,
      });

      const responses: FunctionResponse[] = [];
      for await (const event of runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'what is adk'}]},
      })) {
        for (const part of event.content?.parts ?? []) {
          if (part.functionResponse) {
            responses.push(part.functionResponse);
          }
        }
      }

      expect(queries).toEqual(['what is adk']);
      expect(responses).toEqual([
        expect.objectContaining({
          name: 'serper_dev_tool',
          response: {results: ['adk-js']},
        }),
      ]);
    });
  });
});
