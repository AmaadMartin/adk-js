/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from google/adk-python
// tests/unittests/plugins/test_multimodal_tool_results_plugin.py @ main.

import {
  BaseLlm,
  BaseLlmConnection,
  Context,
  createSession,
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  MultimodalToolResultsPlugin,
  MultimodalToolResultsRetention,
  PARTS_RETURNED_BY_TOOLS_ID,
  PluginManager,
  SESSION_PARTS_RETURNED_BY_TOOLS_ID,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {cloneDeep} from 'lodash-es';
import {describe, expect, it} from 'vitest';

import {
  CURRENT_TURN_PARTS_ID,
  SESSION_UPDATED_KEY,
} from '../../src/plugins/multimodal_tool_results_plugin.js';

const TEST_TOOL = new FunctionTool({
  name: 'test_tool',
  description: 'a tool used only to satisfy the callback signature',
  execute: async () => ({}),
});

/** Builds a context whose state reads and writes `sessionState` in place. */
function createContext(sessionState: Record<string, unknown>): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'user-1',
        state: sessionState,
      }),
      pluginManager: new PluginManager([]),
    }),
  });
}

function callAfterTool(
  plugin: MultimodalToolResultsPlugin,
  toolContext: Context,
  result: unknown,
): Promise<Record<string, unknown> | undefined> {
  return plugin.afterToolCallback({
    tool: TEST_TOOL,
    toolArgs: {},
    toolContext,
    result,
  });
}

function createRequest(contents: Content[]): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}};
}

function lastParts(request: LlmRequest): Part[] | undefined {
  return request.contents[request.contents.length - 1].parts;
}

/**
 * Simulates a turn boundary.
 *
 * `Runner` re-reads the session per invocation and the session layer never
 * persists `temp:` keys, so a new turn starts with those keys gone and a fresh
 * `Context`. Python's tests reach into `state._value` / `state._delta`
 * instead, which adk-js forbids.
 */
function startNextTurn(sessionState: Record<string, unknown>): Context {
  for (const key of Object.keys(sessionState)) {
    if (key.startsWith('temp:')) {
      delete sessionState[key];
    }
  }
  return createContext(sessionState);
}

const FILE_PART: Part = {
  fileData: {fileUri: 'gs://bucket/doc.pdf', mimeType: 'application/pdf'},
};
const BINARY_PART: Part = {
  inlineData: {data: 'ZmFrZSBpbWFnZSBkYXRh', mimeType: 'image/png'},
};

/** A model that replays a scripted list of responses, one per call. */
class ScriptedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private next = 0;

  constructor(private readonly responses: Content[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(cloneDeep(request));
    yield {content: this.responses[this.next++]};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

describe('MultimodalToolResultsPlugin', () => {
  it('test_tool_returning_parts_are_added_to_llm_request', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext({});
    const parts: Part[] = [{text: 'part1'}, {text: 'part2'}];

    const result = await callAfterTool(plugin, toolContext, parts);

    expect(result).toBeUndefined();
    expect(toolContext.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(true);
    expect(toolContext.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual(parts);

    const llmRequest = createRequest([{parts: []}]);
    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest,
    });

    expect(lastParts(llmRequest)).toEqual(parts);
  });

  it('test_tool_returning_non_list_of_parts_is_unchanged', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext({});
    const originalResult = {some: 'data'};

    const result = await callAfterTool(plugin, toolContext, originalResult);

    expect(result).toBe(originalResult);
    expect(toolContext.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(false);

    const llmRequest = createRequest([{parts: [{text: 'original'}]}]);
    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest,
    });

    expect(lastParts(llmRequest)).toEqual([{text: 'original'}]);
  });

  it('test_empty_contents_leaves_saved_parts_pending', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext({});
    const parts: Part[] = [{text: 'part1'}];

    await callAfterTool(plugin, toolContext, parts);

    const llmRequest = createRequest([]);
    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest,
    });

    expect(llmRequest.contents).toEqual([]);
    expect(toolContext.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual(parts);
  });

  it('test_session_retention_reattaches_parts_across_turns', async () => {
    const anotherFilePart: Part = {
      fileData: {
        fileUri: 'gs://bucket/another_document.pdf',
        mimeType: 'application/pdf',
      },
    };
    const model = new ScriptedLlm([
      {
        role: 'model',
        parts: [{functionCall: {name: 'getDocument', args: {}, id: 'c1'}}],
      },
      {role: 'model', parts: [{text: 'Here is a summary of the document.'}]},
      {
        role: 'model',
        parts: [
          {functionCall: {name: 'getAnotherDocument', args: {}, id: 'c2'}},
        ],
      },
      {
        role: 'model',
        parts: [{text: 'Here is a summary of the second document.'}],
      },
    ]);
    const agent = new LlmAgent({
      name: 'root_agent',
      model,
      tools: [
        new FunctionTool({
          name: 'getDocument',
          description: 'fetches a document',
          execute: async () => FILE_PART,
        }),
        new FunctionTool({
          name: 'getAnotherDocument',
          description: 'fetches another document',
          execute: async () => anotherFilePart,
        }),
      ],
    });
    const runner = new InMemoryRunner({
      agent,
      plugins: [new MultimodalToolResultsPlugin({retention: 'session'})],
    });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user_1',
    });

    for (const text of [
      'Please fetch the document',
      'Please fetch another document',
    ]) {
      for await (const _event of runner.runAsync({
        userId: 'user_1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text}]},
      })) {
        // Drain the turn; the assertions are on the recorded model requests.
      }
    }

    expect(model.requests).toHaveLength(4);
    expect(lastParts(model.requests[0])).not.toContainEqual(FILE_PART);
    expect(lastParts(model.requests[1])).toContainEqual(FILE_PART);
    expect(lastParts(model.requests[2])).toContainEqual(FILE_PART);
    expect(lastParts(model.requests[2])).not.toContainEqual(anotherFilePart);
    expect(lastParts(model.requests[3])).toContainEqual(anotherFilePart);
    expect(lastParts(model.requests[3])).not.toContainEqual(FILE_PART);
  });

  it('test_multiple_tools_returning_parts_are_accumulated', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext({});
    const parts1: Part[] = [{text: 'part1'}];
    const parts2: Part[] = [{text: 'part2'}];

    await callAfterTool(plugin, toolContext, parts1);
    await callAfterTool(plugin, toolContext, parts2);

    expect(toolContext.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(true);
    expect(toolContext.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
      ...parts1,
      ...parts2,
    ]);

    const llmRequest = createRequest([{parts: []}]);
    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest,
    });

    expect(lastParts(llmRequest)).toEqual([...parts1, ...parts2]);
  });

  it('test_session_retention_serializes_parts_in_state', async () => {
    const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
    const toolContext = createContext({});
    const parts: Part[] = [{text: 'part1'}, {text: 'part2'}];

    await callAfterTool(plugin, toolContext, parts);

    expect(toolContext.state.has(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toBe(
      true,
    );
    const stored = toolContext.state.get<Part[]>(
      SESSION_PARTS_RETURNED_BY_TOOLS_ID,
    );
    // Python asserts `isinstance(p, dict)`; a TypeScript `Part` is already a
    // plain object, so the observable property is that the stored parts are
    // JSON copies rather than the caller's own objects.
    expect(stored).toEqual(JSON.parse(JSON.stringify(parts)));
    expect(stored?.[0]).not.toBe(parts[0]);
  });

  it('test_session_retention_replaces_parts_on_new_invocation', async () => {
    const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
    const sessionState: Record<string, unknown> = {};
    const turn1Context = createContext(sessionState);
    const partsTurn1: Part[] = [{text: 'part1'}];
    const partsTurn2: Part[] = [{text: 'part2'}];

    await callAfterTool(plugin, turn1Context, partsTurn1);
    expect(turn1Context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual(
      partsTurn1,
    );

    const turn2Context = startNextTurn(sessionState);
    await callAfterTool(plugin, turn2Context, partsTurn2);

    expect(turn2Context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual(
      partsTurn2,
    );
  });

  it('test_session_retention_accumulates_parts_within_same_invocation', async () => {
    const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
    const toolContext = createContext({});
    const parts1: Part[] = [{text: 'part1'}];
    const parts2: Part[] = [{text: 'part2'}];

    await callAfterTool(plugin, toolContext, parts1);
    await callAfterTool(plugin, toolContext, parts2);

    expect(toolContext.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
      ...parts1,
      ...parts2,
    ]);
  });

  it('test_session_retention_skips_binary_parts', async () => {
    const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
    const toolContext = createContext({});
    const parts: Part[] = [BINARY_PART];

    await callAfterTool(plugin, toolContext, parts);

    expect(toolContext.state.has(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toBe(
      false,
    );
    expect(toolContext.state.has(CURRENT_TURN_PARTS_ID)).toBe(true);
    expect(toolContext.state.get(CURRENT_TURN_PARTS_ID)).toEqual(parts);

    const llmRequest = createRequest([{parts: []}]);
    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest,
    });

    expect(lastParts(llmRequest)).toEqual([BINARY_PART]);
    expect(toolContext.state.get(CURRENT_TURN_PARTS_ID)).toEqual([]);
  });

  it('test_session_retention_mixed_parts', async () => {
    const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
    const toolContext = createContext({});
    const parts: Part[] = [FILE_PART, BINARY_PART];

    await callAfterTool(plugin, toolContext, parts);

    expect(toolContext.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
      FILE_PART,
    ]);
    expect(toolContext.state.get(CURRENT_TURN_PARTS_ID)).toEqual(parts);

    const llmRequest = createRequest([{parts: []}]);
    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest,
    });

    expect(lastParts(llmRequest)).toEqual([FILE_PART, BINARY_PART]);
    expect(toolContext.state.get(CURRENT_TURN_PARTS_ID)).toEqual([]);
    expect(toolContext.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
      FILE_PART,
    ]);
  });

  it('test_session_retention_retains_across_turns_when_intermediate_turn_only_returns_binary_parts', async () => {
    const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
    const sessionState: Record<string, unknown> = {};
    const turn1Context = createContext(sessionState);

    await callAfterTool(plugin, turn1Context, [FILE_PART]);
    expect(turn1Context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
      FILE_PART,
    ]);

    const turn2Context = startNextTurn(sessionState);
    await callAfterTool(plugin, turn2Context, [BINARY_PART]);

    expect(turn2Context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
      FILE_PART,
    ]);
    expect(turn2Context.state.get(CURRENT_TURN_PARTS_ID)).toEqual([
      BINARY_PART,
    ]);
  });

  it('test_invalid_retention_raises_value_error', () => {
    expect(
      () =>
        new MultimodalToolResultsPlugin({
          // A narrow cast so the runtime guard is reachable: the union already
          // rejects this value at compile time, but a plain-JS caller or a
          // value read back from JSON can still reach the constructor.
          retention: 'invalid' as MultimodalToolResultsRetention,
        }),
    ).toThrow(/retention must be/);
  });

  it('test_session_retention_retains_parts_on_subsequent_model_calls_in_same_turn', async () => {
    const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
    const toolContext = createContext({});

    await callAfterTool(plugin, toolContext, [FILE_PART]);

    const llmRequest1 = createRequest([{parts: []}]);
    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest: llmRequest1,
    });
    expect(lastParts(llmRequest1)).toEqual([FILE_PART]);
    expect(toolContext.state.get(CURRENT_TURN_PARTS_ID)).toEqual([]);

    await callAfterTool(plugin, toolContext, {status: 'ok'});

    const llmRequest2 = createRequest([{parts: []}]);
    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest: llmRequest2,
    });
    expect(lastParts(llmRequest2)).toEqual([FILE_PART]);
  });
});

// Keeps `SESSION_UPDATED_KEY` honest: `startNextTurn` clears it by prefix, so
// the constant must stay `temp:`-scoped for the replace-on-new-turn behaviour
// above to hold.
describe('MultimodalToolResultsPlugin state keys', () => {
  it('scopes the invocation marker to temp state', () => {
    expect(SESSION_UPDATED_KEY.startsWith('temp:')).toBe(true);
  });
});
