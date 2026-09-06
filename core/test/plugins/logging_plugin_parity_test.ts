/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from adk-python main
 * tests/unittests/plugins/test_logging_plugin.py.
 *
 * Each `it` keeps its Python test name verbatim. Two assertions pin what
 * adk-js renders rather than what adk-python renders; both are marked below.
 */

import {
  Context,
  createEvent,
  createSession,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {LoggingPlugin} from '../../src/plugins/logging_plugin.js';
import {resetLogger, setLogger} from '../../src/utils/logger.js';

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({id: 'session-1', appName: 'test-app'}),
    pluginManager: new PluginManager(),
  });
}

function makeLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'test-model',
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

function makeTool(name: string): FunctionTool {
  return new FunctionTool({name, description: name, execute: () => ({})});
}

describe('LoggingPlugin parity with adk-python', () => {
  let out: string[];
  let plugin: LoggingPlugin;
  let callbackContext: Context;
  let toolContext: Context;
  let invocationContext: InvocationContext;

  beforeEach(() => {
    out = [];
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: (...args: unknown[]) => {
        out.push(args.map((arg) => String(arg)).join(' '));
      },
      warn: () => {},
      error: () => {},
    });
    plugin = new LoggingPlugin();
    invocationContext = makeInvocationContext();
    callbackContext = new Context({invocationContext});
    toolContext = new Context({invocationContext, functionCallId: 'call-1'});
  });

  afterEach(() => {
    resetLogger();
  });

  it('test_before_model_callback_truncates_long_system_instruction', async () => {
    const llmRequest = makeLlmRequest({
      config: {systemInstruction: 'a'.repeat(200) + 'Z'.repeat(50)},
    });

    const result = await plugin.beforeModelCallback({
      callbackContext,
      llmRequest,
    });

    expect(result).toBeUndefined();
    expect(out.join('\n')).toContain(
      `System Instruction: '${'a'.repeat(200)}...'`,
    );
    // Everything past the 200-char budget is dropped, not merely elided.
    expect(out.join('\n')).not.toContain('Z');
  });

  it('test_before_model_callback_keeps_system_instruction_at_budget', async () => {
    const llmRequest = makeLlmRequest({
      config: {systemInstruction: 'a'.repeat(200)},
    });

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(out.join('\n')).toContain(
      `System Instruction: '${'a'.repeat(200)}'`,
    );
  });

  it('test_before_model_callback_lists_available_tool_names', async () => {
    const llmRequest = makeLlmRequest({
      toolsDict: {alpha: makeTool('alpha'), beta: makeTool('beta')},
    });

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    // adk-python prints the Python list repr `['alpha', 'beta']`; adk-js
    // interpolates the array into a template literal.
    expect(out.join('\n')).toContain('Available Tools: alpha,beta');
    expect(out.join('\n')).toContain('Model: test-model');
  });

  it('test_after_model_callback_logs_error_instead_of_content', async () => {
    const llmResponse: LlmResponse = {
      content: {parts: [{text: 'unreachable-text'}]},
      errorCode: '429',
      errorMessage: 'rate limited',
    };

    const result = await plugin.afterModelCallback({
      callbackContext,
      llmResponse,
    });

    expect(result).toBeUndefined();
    expect(out.join('\n')).toContain('ERROR - Code: 429');
    expect(out.join('\n')).toContain('Error Message: rate limited');
    // An errored response carries no usable content; logging it would bury the
    // error under an empty "Content:" line.
    expect(out.join('\n')).not.toContain('unreachable-text');
    expect(out.join('\n')).not.toContain('Content:');
  });

  it('test_after_model_callback_logs_content_and_token_usage', async () => {
    const llmResponse: LlmResponse = {
      content: {parts: [{text: 'hello'}]},
      usageMetadata: {promptTokenCount: 11, candidatesTokenCount: 7},
    };

    await plugin.afterModelCallback({callbackContext, llmResponse});

    expect(out.join('\n')).toContain("Content: text: 'hello'");
    expect(out.join('\n')).toContain('Token Usage - Input: 11, Output: 7');
  });

  it('test_on_event_callback_summarizes_function_parts', async () => {
    const event = createEvent({
      author: 'test-agent',
      content: {
        parts: [
          {functionCall: {name: 'do_thing', args: {x: 1}}},
          {functionResponse: {name: 'do_thing', response: {ok: true}}},
        ],
      },
    });

    const result = await plugin.onEventCallback({invocationContext, event});

    expect(result).toBeUndefined();
    expect(out.join('\n')).toContain(
      'Content: function_call: do_thing | function_response: do_thing',
    );
    // adk-python prints the Python list repr `['do_thing']`.
    expect(out.join('\n')).toContain('Function Calls: do_thing');
    expect(out.join('\n')).toContain('Function Responses: do_thing');
  });

  it('test_on_event_callback_renders_absent_content_as_none', async () => {
    const event = createEvent({author: 'test-agent'});

    await plugin.onEventCallback({invocationContext, event});

    expect(out.join('\n')).toContain('Content: None');
  });

  it('test_on_event_callback_truncates_long_text_part', async () => {
    // The id is pinned because the plugin logs it and `createEvent` generates
    // a random one, which can itself contain the 'Z' this test looks for.
    const event = createEvent({
      id: 'event-1',
      author: 'test-agent',
      content: {parts: [{text: 'a'.repeat(200) + 'Z'.repeat(50)}]},
    });

    await plugin.onEventCallback({invocationContext, event});

    expect(out.join('\n')).toContain(`text: '${'a'.repeat(200)}...'`);
    expect(out.join('\n')).not.toContain('Z');
  });

  it('test_before_tool_callback_truncates_long_arguments', async () => {
    const toolArgs = {payload: 'a'.repeat(400)};

    const result = await plugin.beforeToolCallback({
      tool: makeTool('my_tool'),
      toolArgs,
      toolContext,
    });

    expect(result).toBeUndefined();
    // adk-python asserts `str(tool_args)[:300]`, a Python dict repr; adk-js
    // emits JSON.
    expect(out.join('\n')).toContain(
      `Arguments: ${JSON.stringify(toolArgs).slice(0, 300)}...}`,
    );
    // The full payload must not reach the console.
    expect(out.join('\n')).not.toContain(JSON.stringify(toolArgs));
  });

  it('test_before_model_callback_formats_content_system_instruction', async () => {
    const llmRequest = makeLlmRequest({
      config: {
        systemInstruction: {role: 'system', parts: [{text: 'Stay concise.'}]},
      },
    });

    const result = await plugin.beforeModelCallback({
      callbackContext,
      llmRequest,
    });

    expect(result).toBeUndefined();
    expect(out.join('\n')).toContain('Stay concise.');
  });

  it('test_before_model_callback_formats_list_system_instruction', async () => {
    const llmRequest = makeLlmRequest({
      config: {
        systemInstruction: [{text: 'Stay concise.'}, {text: 'Cite sources.'}],
      },
    });

    const result = await plugin.beforeModelCallback({
      callbackContext,
      llmRequest,
    });

    expect(result).toBeUndefined();
    expect(out.join('\n')).toContain('Stay concise.');
    expect(out.join('\n')).toContain('Cite sources.');
  });
});
