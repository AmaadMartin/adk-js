/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  BaseTool,
  Context,
  createSession,
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  MultimodalToolResultsPlugin,
  PARTS_RETURNED_BY_TOOLS_ID,
  PluginManager,
  Session,
  SESSION_PARTS_RETURNED_BY_TOOLS_ID,
} from '@google/adk';
import {
  Content,
  createPartFromBase64,
  createPartFromUri,
  Part,
} from '@google/genai';
import {cloneDeep} from 'lodash-es';
import {describe, expect, it} from 'vitest';

import {
  CURRENT_TURN_PARTS_ID,
  isPart,
  MultimodalToolResultsRetention,
  SESSION_UPDATED_KEY,
} from '../../src/plugins/multimodal_tool_results_plugin.js';

const TEMP_KEYS = [
  PARTS_RETURNED_BY_TOOLS_ID,
  CURRENT_TURN_PARTS_ID,
  SESSION_UPDATED_KEY,
];

const filePart = createPartFromUri('gs://bucket/doc.pdf', 'application/pdf');
const anotherFilePart = createPartFromUri(
  'gs://bucket/another_doc.pdf',
  'application/pdf',
);
const binaryPart = createPartFromBase64('ZmFrZSBpbWFnZSBkYXRh', 'image/png');

const mockTool = new FunctionTool({
  name: 'test_tool',
  description: 'A tool that exists only to satisfy the callback signature.',
  execute: () => ({}),
});

function newSession(): Session {
  return createSession({id: 'test-session', appName: 'test-app'});
}

/** Builds a callback context over `session`, with an empty state delta. */
function newContext(session: Session): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session,
      pluginManager: new PluginManager([]),
    }),
  });
}

/**
 * Simulates a turn boundary: the session layer strips `temp:` keys before it
 * persists an event, and a new turn starts with a fresh state delta.
 */
function nextTurn(session: Session): Context {
  for (const key of TEMP_KEYS) {
    delete session.state[key];
  }
  return newContext(session);
}

function newRequest(contents: Content[]): LlmRequest {
  return {contents, liveConnectConfig: {}, toolsDict: {}};
}

function callAfterTool(
  plugin: MultimodalToolResultsPlugin,
  toolContext: Context,
  result: unknown,
): Promise<Record<string, unknown> | undefined> {
  return plugin.afterToolCallback({
    tool: mockTool,
    toolArgs: {},
    toolContext,
    // A tool may return any value at runtime; the callback signature declares
    // the narrower record the framework normalizes it to.
    result: result as Record<string, unknown>,
  });
}

function lastParts(request: LlmRequest): Part[] {
  return request.contents[request.contents.length - 1].parts ?? [];
}

/** A plugin that records the tool calls its afterToolCallback is shown. */
class RecordingPlugin extends BasePlugin {
  readonly seen: string[] = [];

  constructor() {
    super('recording_plugin');
  }

  override async afterToolCallback({
    tool,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    this.seen.push(tool.name);
    return undefined;
  }
}

/** A model that replays a queued script and records every request it saw. */
class ScriptedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private readonly script: Content[];
  private next = 0;

  constructor(script: Content[]) {
    super({model: 'scripted-llm'});
    this.script = script;
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(cloneDeep(request));
    yield {content: this.script[this.next++]};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

describe('MultimodalToolResultsPlugin', () => {
  describe('constructor', () => {
    it('uses the default name', () => {
      expect(new MultimodalToolResultsPlugin().name).toBe(
        'multimodal_tool_results_plugin',
      );
    });

    it('honors a custom name', () => {
      expect(new MultimodalToolResultsPlugin({name: 'custom'}).name).toBe(
        'custom',
      );
    });
  });

  describe('retention validation', () => {
    it.each(['next_model_call', 'session'] as const)(
      'accepts %s',
      (retention) => {
        expect(
          () => new MultimodalToolResultsPlugin({retention}),
        ).not.toThrow();
      },
    );

    it('rejects an unknown mode', () => {
      // The cast supplies the value a JavaScript caller or a JSON config can
      // still pass, which is what the runtime guard exists for.
      const retention = 'invalid' as MultimodalToolResultsRetention;
      expect(() => new MultimodalToolResultsPlugin({retention})).toThrowError(
        "retention must be 'next_model_call' or 'session', got invalid",
      );
    });
  });

  describe('isPart', () => {
    it.each([
      {name: 'a text part', value: {text: 'x'}},
      {name: 'a file part', value: filePart},
      {name: 'an inlineData part', value: binaryPart},
    ])('accepts $name', ({value}) => {
      expect(isPart(value)).toBe(true);
    });

    it.each([
      {name: 'a plain result object', value: {some: 'data'}},
      {name: 'an empty object', value: {}},
      {name: 'an object with an extra field', value: {text: 'x', extra: 1}},
      {
        name: 'an object whose only part field is undefined',
        value: {text: undefined},
      },
      {name: 'an array', value: []},
      {name: 'null', value: null},
      {name: 'undefined', value: undefined},
      {name: 'a string', value: 'str'},
      {name: 'a number', value: 42},
    ])('rejects $name', ({value}) => {
      expect(isPart(value)).toBe(false);
    });
  });

  describe('the rest of the callback chain', () => {
    it.each([
      {name: 'an ordinary result', result: {some: 'data'}},
      {name: 'a part result', result: filePart},
    ])('still runs the plugins after this one for $name', async ({result}) => {
      const recorder = new RecordingPlugin();
      const manager = new PluginManager([
        new MultimodalToolResultsPlugin(),
        recorder,
      ]);

      const response = await manager.runAfterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: newContext(newSession()),
        result: result as Record<string, unknown>,
      });

      expect(response).toBeUndefined();
      expect(recorder.seen).toEqual(['test_tool']);
    });

    it("still runs the agent's own afterToolCallback", async () => {
      const seen: string[] = [];
      const model = new ScriptedLlm([
        {role: 'model', parts: [{functionCall: {name: 'get_status'}}]},
        {role: 'model', parts: [{text: 'done'}]},
      ]);
      const agent = new LlmAgent({
        name: 'root_agent',
        model,
        tools: [
          new FunctionTool({
            name: 'get_status',
            description: 'Returns an ordinary record.',
            execute: () => ({status: 'ok'}),
          }),
        ],
        afterToolCallback: ({tool}) => {
          seen.push(tool.name);
          return undefined;
        },
      });
      const runner = new InMemoryRunner({
        agent,
        plugins: [new MultimodalToolResultsPlugin()],
      });
      const session = await runner.sessionService.createSession({
        appName: runner.appName,
        userId: 'test_user',
      });

      for await (const _event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'status?'}]},
      })) {
        // Drain the stream so the turn runs to completion.
      }

      expect(seen).toEqual(['get_status']);
    });
  });

  describe('next_model_call retention', () => {
    it('attaches the parts a tool returned to the next request', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const context = newContext(newSession());
      const parts: Part[] = [{text: 'part1'}, {text: 'part2'}];

      const result = await callAfterTool(plugin, context, parts);

      expect(result).toBeUndefined();
      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual(parts);

      const request = newRequest([{role: 'user', parts: []}]);
      const response = await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(response).toBeUndefined();
      expect(lastParts(request)).toEqual(parts);
      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([]);
    });

    it('wraps a single returned part in an array', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const context = newContext(newSession());

      await callAfterTool(plugin, context, filePart);

      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([filePart]);
    });

    it('buffers nothing for a non-part result and leaves the request alone', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const context = newContext(newSession());
      const original = {some: 'data'};

      const result = await callAfterTool(plugin, context, original);

      expect(result).toBeUndefined();
      expect(context.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(false);

      const request = newRequest([{role: 'user', parts: [{text: 'original'}]}]);
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(lastParts(request)).toEqual([{text: 'original'}]);
    });

    it.each([
      {name: 'an empty array', value: []},
      {name: 'an array of non-part objects', value: [{some: 'data'}]},
      {name: 'an array whose first element is a primitive', value: ['x']},
      {name: 'an array whose first element is null', value: [null]},
    ])('buffers nothing for $name', async ({value}) => {
      const plugin = new MultimodalToolResultsPlugin();
      const context = newContext(newSession());

      expect(await callAfterTool(plugin, context, value)).toBeUndefined();
      expect(context.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(false);
    });

    it.each([
      {name: 'nothing is buffered', buffered: undefined},
      {name: 'the buffer is empty', buffered: [] as Part[]},
    ])('does not touch the request when $name', async ({buffered}) => {
      const plugin = new MultimodalToolResultsPlugin();
      const context = newContext(newSession());
      if (buffered) {
        context.state.set(PARTS_RETURNED_BY_TOOLS_ID, buffered);
      }

      const request = newRequest([{role: 'user', parts: [{text: 'keep'}]}]);
      const response = await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(response).toBeUndefined();
      expect(lastParts(request)).toEqual([{text: 'keep'}]);
    });

    it('leaves the saved parts pending when the request has no contents', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const context = newContext(newSession());
      const parts: Part[] = [{text: 'part1'}];
      await callAfterTool(plugin, context, parts);

      const request = newRequest([]);
      const response = await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(response).toBeUndefined();
      expect(request.contents).toEqual([]);
      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual(parts);
    });

    it('accumulates the parts of two tool calls in order', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const context = newContext(newSession());

      await callAfterTool(plugin, context, [{text: 'part1'}]);
      await callAfterTool(plugin, context, [{text: 'part2'}]);

      const request = newRequest([{role: 'user', parts: []}]);
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(lastParts(request)).toEqual([{text: 'part1'}, {text: 'part2'}]);
    });

    it('appends after the parts the last content already has', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const context = newContext(newSession());
      await callAfterTool(plugin, context, [filePart]);

      const request = newRequest([
        {role: 'user', parts: [{text: 'first'}]},
        {role: 'user', parts: [{text: 'second'}]},
      ]);
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(request.contents[0].parts).toEqual([{text: 'first'}]);
      expect(lastParts(request)).toEqual([{text: 'second'}, filePart]);
    });

    it('attaches to a last content that has no parts field', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const context = newContext(newSession());
      await callAfterTool(plugin, context, [filePart]);

      const request = newRequest([{role: 'user'}]);
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(lastParts(request)).toEqual([filePart]);
    });
  });

  describe('session retention', () => {
    const sessionPlugin = () =>
      new MultimodalToolResultsPlugin({retention: 'session'});

    it('stores a deep copy of the parts in session state', async () => {
      const plugin = sessionPlugin();
      const context = newContext(newSession());
      const parts: Part[] = [{text: 'part1'}, {text: 'part2'}];

      await callAfterTool(plugin, context, parts);

      const stored = context.state.get<Part[]>(
        SESSION_PARTS_RETURNED_BY_TOOLS_ID,
      );
      expect(stored).toEqual(parts);
      expect(stored?.[0]).not.toBe(parts[0]);
    });

    it('replaces the previous turn parts instead of accumulating', async () => {
      const plugin = sessionPlugin();
      const session = newSession();

      await callAfterTool(plugin, newContext(session), [{text: 'turn1'}]);
      expect(session.state[SESSION_PARTS_RETURNED_BY_TOOLS_ID]).toEqual([
        {text: 'turn1'},
      ]);

      await callAfterTool(plugin, nextTurn(session), [{text: 'turn2'}]);

      expect(session.state[SESSION_PARTS_RETURNED_BY_TOOLS_ID]).toEqual([
        {text: 'turn2'},
      ]);
    });

    it('accumulates the parts of two tool calls in one turn', async () => {
      const plugin = sessionPlugin();
      const context = newContext(newSession());

      await callAfterTool(plugin, context, [{text: 'part1'}]);
      await callAfterTool(plugin, context, [{text: 'part2'}]);

      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        {text: 'part1'},
        {text: 'part2'},
      ]);
    });

    it('keeps an inlineData part out of session state', async () => {
      const plugin = sessionPlugin();
      const context = newContext(newSession());

      await callAfterTool(plugin, context, [binaryPart]);

      expect(context.state.has(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toBe(false);
      expect(context.state.get(CURRENT_TURN_PARTS_ID)).toEqual([binaryPart]);

      const request = newRequest([{role: 'user', parts: []}]);
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(lastParts(request)).toEqual([binaryPart]);
      expect(context.state.get(CURRENT_TURN_PARTS_ID)).toEqual([]);
    });

    it('retains only the file part of a mixed result, attaching both', async () => {
      const plugin = sessionPlugin();
      const context = newContext(newSession());

      await callAfterTool(plugin, context, [filePart, binaryPart]);

      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        filePart,
      ]);
      expect(context.state.get(CURRENT_TURN_PARTS_ID)).toEqual([
        filePart,
        binaryPart,
      ]);

      const request = newRequest([{role: 'user', parts: []}]);
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(lastParts(request)).toEqual([filePart, binaryPart]);
      expect(context.state.get(CURRENT_TURN_PARTS_ID)).toEqual([]);
      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        filePart,
      ]);
    });

    it('keeps earlier session parts when a turn returns only inlineData', async () => {
      const plugin = sessionPlugin();
      const session = newSession();

      await callAfterTool(plugin, newContext(session), [filePart]);
      const secondTurn = nextTurn(session);
      await callAfterTool(plugin, secondTurn, [binaryPart]);

      expect(secondTurn.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        filePart,
      ]);
      expect(secondTurn.state.get(CURRENT_TURN_PARTS_ID)).toEqual([binaryPart]);
    });

    it('re-attaches the session part on a later model call of the same turn', async () => {
      const plugin = sessionPlugin();
      const context = newContext(newSession());
      await callAfterTool(plugin, context, [filePart]);

      const firstRequest = newRequest([{role: 'user', parts: []}]);
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: firstRequest,
      });
      expect(lastParts(firstRequest)).toEqual([filePart]);
      expect(context.state.get(CURRENT_TURN_PARTS_ID)).toEqual([]);

      await callAfterTool(plugin, context, {status: 'ok'});

      const secondRequest = newRequest([{role: 'user', parts: []}]);
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: secondRequest,
      });

      expect(lastParts(secondRequest)).toEqual([filePart]);
    });

    it('leaves the turn parts pending when the request has no contents', async () => {
      const plugin = sessionPlugin();
      const context = newContext(newSession());
      await callAfterTool(plugin, context, [filePart]);

      const request = newRequest([]);
      const response = await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(response).toBeUndefined();
      expect(request.contents).toEqual([]);
      expect(context.state.get(CURRENT_TURN_PARTS_ID)).toEqual([filePart]);
    });

    it('does not touch the request when nothing is buffered', async () => {
      const plugin = sessionPlugin();
      const context = newContext(newSession());

      const request = newRequest([{role: 'user', parts: [{text: 'keep'}]}]);
      const response = await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: request,
      });

      expect(response).toBeUndefined();
      expect(lastParts(request)).toEqual([{text: 'keep'}]);
    });

    it('re-attaches parts across a real turn boundary', async () => {
      const model = new ScriptedLlm([
        {role: 'model', parts: [{functionCall: {name: 'get_document'}}]},
        {role: 'model', parts: [{text: 'Here is the document.'}]},
        {
          role: 'model',
          parts: [{functionCall: {name: 'get_another_document'}}],
        },
        {role: 'model', parts: [{text: 'Here is the second document.'}]},
      ]);
      const agent = new LlmAgent({
        name: 'root_agent',
        model,
        tools: [
          new FunctionTool({
            name: 'get_document',
            description: 'Returns a document.',
            execute: () => filePart,
          }),
          new FunctionTool({
            name: 'get_another_document',
            description: 'Returns another document.',
            execute: () => anotherFilePart,
          }),
        ],
      });
      const runner = new InMemoryRunner({
        agent,
        plugins: [new MultimodalToolResultsPlugin({retention: 'session'})],
      });
      const session = await runner.sessionService.createSession({
        appName: runner.appName,
        userId: 'test_user',
      });

      for (const text of ['Fetch the document', 'Fetch another document']) {
        for await (const _event of runner.runAsync({
          userId: 'test_user',
          sessionId: session.id,
          newMessage: {role: 'user', parts: [{text}]},
        })) {
          // Drain the stream so the turn runs to completion.
        }
      }

      expect(model.requests).toHaveLength(4);
      const attached = model.requests.map(lastParts);
      expect(attached[0]).not.toContainEqual(filePart);
      expect(attached[1]).toContainEqual(filePart);
      // Turn 2 opens with turn 1's part still attached, and closes with it
      // replaced by the part turn 2 returned.
      expect(attached[2]).toContainEqual(filePart);
      expect(attached[2]).not.toContainEqual(anotherFilePart);
      expect(attached[3]).toContainEqual(anotherFilePart);
      expect(attached[3]).not.toContainEqual(filePart);
    });
  });
});
