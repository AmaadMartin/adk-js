/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the behaviour the adk-python reference suite does not reach: the
 * two constructor options, the prompt it builds, the not-an-object branch, and
 * the keys a model can choose. The ported reference tests live in
 * `tool_spec_mock_strategy_test.ts`.
 */

import {
  BaseTool,
  LLMRegistry,
  ToolConnectionMap,
  ToolSpecMockStrategy,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  connectionMap,
  declaredTool,
  promptOf,
  RecordingLlm,
  stubRegistryWithText,
} from './mock_strategy_test_utils.js';

const OBJECT_PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype);

interface MockOptions {
  tool?: BaseTool;
  args?: Record<string, unknown>;
  stateStore?: Record<string, Record<string, unknown>>;
  toolConnectionMap?: ToolConnectionMap;
  environmentData?: string;
  tracing?: string;
}

function mock(
  strategy: ToolSpecMockStrategy,
  options: MockOptions = {},
): Promise<Record<string, unknown>> {
  return strategy.mock({
    tool: options.tool ?? declaredTool('create_ticket'),
    args: options.args ?? {},
    stateStore: options.stateStore ?? {},
    toolConnectionMap: options.toolConnectionMap,
    environmentData: options.environmentData,
    tracing: options.tracing,
  });
}

function creates(parameterName: string, ...creatingTools: string[]) {
  return connectionMap({parameterName, creatingTools, consumingTools: []});
}

describe('ToolSpecMockStrategy own behaviour', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(
      OBJECT_PROTOTYPE_KEYS,
    );
  });

  describe('a response that is not a JSON object', () => {
    it.each(['["T-1"]', '42', 'null', '"a string"'])(
      'reports %s as an error carrying the raw output',
      async (responseText) => {
        stubRegistryWithText([responseText]);
        const strategy = new ToolSpecMockStrategy('fake-model', {});

        const result = await mock(strategy);

        expect(result).toEqual({
          status: 'error',
          errorMessage: 'Generated mock response was not a JSON object.',
          llmOutput: responseText,
        });
      },
    );
  });

  describe('the value that keys a state store entry', () => {
    it.each([
      ['0', 0],
      ['false', false],
      ['an empty string', ''],
    ])('records an id of %s, which is present but falsy', async (_, id) => {
      stubRegistryWithText([JSON.stringify({ticket_id: id})]);
      const strategy = new ToolSpecMockStrategy('fake-model', {});
      const stateStore = {};

      const result = await mock(strategy, {
        stateStore,
        toolConnectionMap: creates('ticket_id', 'create_ticket'),
      });

      expect(stateStore).toEqual({ticket_id: {[String(id)]: result}});
    });

    it('records nothing when the id is null', async () => {
      stubRegistryWithText(['{"ticket_id": null}']);
      const strategy = new ToolSpecMockStrategy('fake-model', {});
      const stateStore = {};

      await mock(strategy, {
        stateStore,
        toolConnectionMap: creates('ticket_id', 'create_ticket'),
      });

      expect(stateStore).toEqual({});
    });

    it('stringifies a non-string id', async () => {
      stubRegistryWithText(['{"ticket_id": 42}']);
      const strategy = new ToolSpecMockStrategy('fake-model', {});
      const stateStore = {};

      const result = await mock(strategy, {
        stateStore,
        toolConnectionMap: creates('ticket_id', 'create_ticket'),
      });

      expect(stateStore).toEqual({ticket_id: {'42': result}});
    });

    it('finds an id inside an array', async () => {
      stubRegistryWithText(['{"tickets": [{"ticket_id": "T-9"}]}']);
      const strategy = new ToolSpecMockStrategy('fake-model', {});
      const stateStore = {};

      const result = await mock(strategy, {
        stateStore,
        toolConnectionMap: creates('ticket_id', 'create_ticket'),
      });

      expect(stateStore).toEqual({ticket_id: {'T-9': result}});
    });

    it('keeps searching past an array that holds no match', async () => {
      stubRegistryWithText([
        '{"tags": {"labels": ["a", "b"]}, "meta": {"ticket_id": "T-10"}}',
      ]);
      const strategy = new ToolSpecMockStrategy('fake-model', {});
      const stateStore = {};

      const result = await mock(strategy, {
        stateStore,
        toolConnectionMap: creates('ticket_id', 'create_ticket'),
      });

      expect(stateStore).toEqual({ticket_id: {'T-10': result}});
    });

    it('writes only the parameter the tool creates', async () => {
      stubRegistryWithText(['{"ticket_id": "T-11", "user_id": "U-1"}']);
      const strategy = new ToolSpecMockStrategy('fake-model', {});
      const stateStore = {};

      const result = await mock(strategy, {
        stateStore,
        toolConnectionMap: {
          statefulParameters: [
            {
              parameterName: 'ticket_id',
              creatingTools: ['create_ticket'],
              consumingTools: [],
            },
            {
              parameterName: 'user_id',
              creatingTools: ['create_user'],
              consumingTools: ['create_ticket'],
            },
          ],
        },
      });

      expect(stateStore).toEqual({ticket_id: {'T-11': result}});
    });
  });

  describe('keys chosen by the model', () => {
    it('stores a __proto__ parameter name as an own property', async () => {
      stubRegistryWithText(['{"__proto__": "T-12"}']);
      const strategy = new ToolSpecMockStrategy('fake-model', {});
      const stateStore: Record<string, Record<string, unknown>> = {};

      const result = await mock(strategy, {
        stateStore,
        toolConnectionMap: creates('__proto__', 'create_ticket'),
      });

      expect(Object.hasOwn(stateStore, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(stateStore)).toBe(Object.prototype);
      expect(stateStore['__proto__']['T-12']).toBe(result);
    });

    it('stores a __proto__ entity id as an own property', async () => {
      stubRegistryWithText(['{"ticket_id": "__proto__"}']);
      const strategy = new ToolSpecMockStrategy('fake-model', {});
      const stateStore: Record<string, Record<string, unknown>> = {};

      const result = await mock(strategy, {
        stateStore,
        toolConnectionMap: creates('ticket_id', 'create_ticket'),
      });

      const bucket = stateStore['ticket_id'];
      expect(Object.hasOwn(bucket, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(bucket)).toBe(Object.prototype);
      expect(bucket['__proto__']).toBe(result);
    });

    it.each(['__proto__', 'constructor', 'toString'])(
      'does not mistake the inherited %s for a value in the response',
      async (parameterName) => {
        stubRegistryWithText(['{"data": {"status": "open"}}']);
        const strategy = new ToolSpecMockStrategy('fake-model', {});
        const stateStore = {};

        await mock(strategy, {
          stateStore,
          toolConnectionMap: creates(parameterName, 'create_ticket'),
        });

        expect(stateStore).toEqual({});
      },
    );
  });

  describe('the code fence around the response', () => {
    it.each([
      ['a bare fence', '```\n{"ticket_id": "T-13"}\n```'],
      [
        'a fence with a trailing newline',
        '```json\n{"ticket_id": "T-13"}\n```\n',
      ],
    ])('unwraps %s', async (_, responseText) => {
      stubRegistryWithText([responseText]);
      const strategy = new ToolSpecMockStrategy('fake-model', {});

      const result = await mock(strategy);

      expect(result).toEqual({ticket_id: 'T-13'});
    });
  });

  describe('the prompt it builds', () => {
    async function promptFor(options: MockOptions): Promise<string> {
      const llm = stubRegistryWithText(['{}']);
      await mock(new ToolSpecMockStrategy('fake-model', {}), options);
      return promptOf(llm);
    }

    it('includes the environment data when it is given', async () => {
      const prompt = await promptFor({environmentData: 'two open tickets'});

      expect(prompt).toContain('<environment_data>');
      expect(prompt).toContain('two open tickets');
      expect(prompt).toContain('</environment_data>');
    });

    it('omits the environment data block when there is none', async () => {
      const prompt = await promptFor({});

      expect(prompt).not.toContain('<environment_data>');
    });

    it('includes the tracing history when it is given', async () => {
      const prompt = await promptFor({tracing: 'create_ticket -> T-0'});

      expect(prompt).toContain('<tracing>');
      expect(prompt).toContain('create_ticket -> T-0');
      expect(prompt).toContain('</tracing>');
    });

    it('omits the tracing block when there is none', async () => {
      const prompt = await promptFor({});

      expect(prompt).not.toContain('<tracing>');
    });

    it('renders an absent connection map as an empty quoted string', async () => {
      const prompt = await promptFor({});

      expect(prompt).toContain(
        "Here is the map of how tools connect via stateful parameters:\n  ''",
      );
    });

    it('renders a connection map as its JSON', async () => {
      const toolConnectionMap = creates('ticket_id', 'create_ticket');

      const prompt = await promptFor({toolConnectionMap});

      expect(prompt).toContain(JSON.stringify(toolConnectionMap, null, 2));
    });

    it('carries the tool schema, arguments and state store', async () => {
      const stateStore = {ticket_id: {'T-14': {status: 'open'}}};

      const prompt = await promptFor({args: {title: 'a bug'}, stateStore});

      expect(prompt).toContain('Tool Name: create_ticket');
      expect(prompt).toContain('Tool Description: create_ticket description');
      expect(prompt).toContain(
        JSON.stringify({name: 'create_ticket'}, null, 2),
      );
      expect(prompt).toContain(JSON.stringify({title: 'a bug'}, null, 2));
      expect(prompt).toContain(JSON.stringify(stateStore, null, 2));
    });
  });

  describe('the request it sends', () => {
    it('resolves the configured model name through the registry', async () => {
      const llm: RecordingLlm = stubRegistryWithText(['{}']);
      const strategy = new ToolSpecMockStrategy('fake-model', {});

      await mock(strategy);

      expect(LLMRegistry.newLlm).toHaveBeenCalledWith('fake-model');
      expect(llm.requests[0].model).toBe(llm.model);
    });

    it('asks for JSON, keeping the caller config', async () => {
      const llm: RecordingLlm = stubRegistryWithText(['{}']);
      const strategy = new ToolSpecMockStrategy('fake-model', {
        temperature: 0.5,
      });

      await mock(strategy);

      expect(llm.requests[0].config).toEqual({
        temperature: 0.5,
        responseMimeType: 'application/json',
      });
    });

    it('resolves the model once, however many calls it mocks', async () => {
      stubRegistryWithText(['{}'], ['{}']);
      const strategy = new ToolSpecMockStrategy('fake-model', {});

      await mock(strategy);
      await mock(strategy);

      expect(LLMRegistry.newLlm).toHaveBeenCalledTimes(1);
    });
  });

  describe('an unknown model name', () => {
    it('is reported on the first mock, not at construction', async () => {
      const strategy = new ToolSpecMockStrategy('not-a-real-model', {});

      await expect(mock(strategy)).rejects.toThrow(
        'Model not-a-real-model not found.',
      );
    });
  });
});
