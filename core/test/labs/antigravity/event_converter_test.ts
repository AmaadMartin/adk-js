/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Antigravity step-to-event converter.
 *
 * Ported from adk-python
 * `tests/unittests/labs/antigravity/test_event_converter.py` at `a119dd77`.
 * The `it(...)` names are the reference test names, verbatim.
 */

import {
  AntigravityStep,
  AntigravityStepStatus,
  AntigravityToolResult,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import {
  convertStepToEvents,
  drainToolResults,
  finalModelText,
} from '@google/adk/labs/antigravity/event_converter.js';
import {
  createToolErrorCapture,
  ToolResultBuffer,
} from '@google/adk/labs/antigravity/tool_result_capture.js';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

/** An invocation context carrying the two fields the converter reads. */
function makeCtx(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_1',
    branch: 'main',
    session: createSession({id: 'sess_1', appName: 'test_app'}),
    pluginManager: new PluginManager(),
  });
}

/**
 * Replays steps through the converter carrying one turn's state across.
 *
 * A tool call and its response arrive on different steps, so a converter
 * exercised one isolated step at a time cannot show whether they pair up.
 */
class Turn {
  readonly ctx = makeCtx();
  readonly seenToolCalls = new Set<string>();
  readonly seenToolResults = new Set<string>();

  constructor(readonly toolResults?: ToolResultBuffer) {}

  step(step: AntigravityStep, streaming = false): Event[] {
    return convertStepToEvents(step, {
      ctx: this.ctx,
      author: 'agy',
      seenToolCalls: this.seenToolCalls,
      seenToolResults: this.seenToolResults,
      toolResults: this.toolResults,
      streaming,
    });
  }

  /** Drains the buffer as the end of a turn does. */
  flush(): Event[] {
    return drainToolResults({
      ctx: this.ctx,
      seenToolCalls: this.seenToolCalls,
      seenToolResults: this.seenToolResults,
      toolResults: this.toolResults,
    });
  }
}

function convert(step: AntigravityStep, streaming = false): Event[] {
  return new Turn().step(step, streaming);
}

/** Returns [name, id, response] for each function-response part emitted. */
function responses(
  events: Event[],
): Array<[string | undefined, string | undefined, unknown]> {
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse) {
        found.push([
          part.functionResponse.name,
          part.functionResponse.id,
          part.functionResponse.response,
        ]);
      }
    }
  }
  return found;
}

// --- The two real tool-step shapes -----------------------------------------
//
// One tool call arrives as two updates to one step: ACTIVE when the model
// issues it, then DONE (or ERROR) when it finishes. Which update carries
// `toolCalls` is the whole difference between the two kinds of tool.

/** A builtin's call id defaults to the step id, `<trajectoryId>:<index>`. */
const BUILTIN_CALL_ID = 'traj_1:2';
/**
 * What the hook is handed for that same builtin: the model's own call id, or a
 * hash of the step id. Never the step id itself.
 */
const BUILTIN_HOOK_CALL_ID = 'toolu_01ABCDEF';
const CLIENT_CALL_ID = 'call_3';

/** One update of a builtin tool's step, which always keeps its `toolCalls`. */
function builtinToolStep(
  status: AntigravityStepStatus,
  content = '',
  error = '',
): AntigravityStep {
  return {
    stepIndex: 2,
    type: 'TOOL_CALL',
    source: 'MODEL',
    status,
    content,
    error,
    toolCalls: [
      {name: 'view_file', args: {file_path: '/foo'}, id: BUILTIN_CALL_ID},
    ],
  };
}

/** The ACTIVE step fabricated when the harness asks us to run a tool. */
function clientToolActiveStep(): AntigravityStep {
  // The only step that ever carries a client tool's call, so the only chance
  // to emit the function call.
  return {
    stepIndex: 1,
    type: 'TOOL_CALL',
    source: 'MODEL',
    status: 'ACTIVE',
    content: '',
    toolCalls: [
      {
        name: 'naming_reviewer',
        args: {request: 'Is "tmp2" a good variable name?'},
        id: CLIENT_CALL_ID,
      },
    ],
  };
}

/** The terminal step for a client tool, with `toolCalls` blanked. */
function clientToolDoneStep(): AntigravityStep {
  return {
    stepIndex: 1,
    type: 'TOOL_CALL',
    source: 'MODEL',
    status: 'DONE',
    content: 'Calling custom tool "naming_reviewer"',
    toolCalls: [],
  };
}

/** A tool result as the post-tool-call hook receives one. */
function toolResult(
  callId: string,
  value?: unknown,
  name = 'naming_reviewer',
): AntigravityToolResult {
  return {name, id: callId, result: value};
}

/** Stands in for the SDK's `ToolExecutionError`. */
class ToolFailure extends Error {
  constructor(
    message: string,
    readonly toolName: string,
    readonly callId?: string,
  ) {
    super(message);
  }
}

describe('convertStepToEvents', () => {
  it('test_completed_model_text_maps_to_one_model_text_event', () => {
    const events = convert({
      stepIndex: 0,
      type: 'TEXT_RESPONSE',
      source: 'MODEL',
      content: 'hello there',
      isCompleteResponse: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('agy');
    expect(events[0].content?.role).toBe('model');
    expect(events[0].content?.parts?.[0].text).toBe('hello there');
  });

  it('test_partial_model_text_produces_no_event', () => {
    // A streaming partial text step carries a cumulative snapshot, not an
    // answer.
    expect(
      convert({
        stepIndex: 0,
        type: 'TEXT_RESPONSE',
        source: 'MODEL',
        content: 'hello',
        contentDelta: 'hello',
      }),
    ).toEqual([]);
  });

  it('test_function_call_maps_to_function_call_event', () => {
    const events = convert({
      stepIndex: 1,
      type: 'TOOL_CALL',
      source: 'MODEL',
      toolCalls: [{name: 'view_file', args: {path: '/x'}, id: 'c1'}],
    });

    expect(events).toHaveLength(1);
    const call = events[0].content?.parts?.[0].functionCall;
    expect(events[0].author).toBe('agy');
    expect(call?.name).toBe('view_file');
    expect(call?.id).toBe('c1');
    expect(call?.args).toEqual({path: '/x'});
  });

  it('test_a_built_in_tool_call_and_result_pair_up_across_its_two_steps', () => {
    const turn = new Turn();

    const active = turn.step(builtinToolStep('ACTIVE'));
    const done = turn.step(builtinToolStep('DONE', 'file contents'));

    expect(active.map((e) => e.content?.parts?.[0].functionCall?.id)).toEqual([
      BUILTIN_CALL_ID,
    ]);
    expect(responses(done)).toEqual([
      ['view_file', BUILTIN_CALL_ID, {result: 'file contents'}],
    ]);
    expect(done[0].author).toBe('view_file');
    expect(done[0].content?.role).toBe('user');
  });

  it('test_a_built_in_tool_is_answered_with_no_buffer_at_all', () => {
    // An agent with no sub-agents registers no hook, so there is no buffer.
    const turn = new Turn(undefined);

    turn.step(builtinToolStep('ACTIVE'));
    const done = turn.step(builtinToolStep('DONE', 'file contents'));

    expect(responses(done)).toEqual([
      ['view_file', BUILTIN_CALL_ID, {result: 'file contents'}],
    ]);
  });

  it('test_a_failed_built_in_tool_step_reports_the_error', () => {
    const turn = new Turn();

    turn.step(builtinToolStep('ACTIVE'));
    const done = turn.step(builtinToolStep('ERROR', '', 'permission denied'));

    expect(responses(done)).toEqual([
      ['view_file', BUILTIN_CALL_ID, {error: 'permission denied'}],
    ]);
  });

  it('reports a status-only message for a failed step carrying no error text', () => {
    const turn = new Turn();

    turn.step(builtinToolStep('ACTIVE'));
    const done = turn.step(builtinToolStep('ERROR'));

    expect(responses(done)).toEqual([
      [
        'view_file',
        BUILTIN_CALL_ID,
        {error: 'Tool call execution failed with status ERROR.'},
      ],
    ]);
  });

  it('answers a completed step carrying no content with success', () => {
    const turn = new Turn();

    turn.step(builtinToolStep('ACTIVE'));
    const done = turn.step(builtinToolStep('DONE'));

    expect(responses(done)).toEqual([
      ['view_file', BUILTIN_CALL_ID, {result: 'success'}],
    ]);
  });

  it('test_a_client_tool_is_answered_from_the_buffered_result', () => {
    const buffer = new ToolResultBuffer();
    const turn = new Turn(buffer);

    turn.step(clientToolActiveStep());
    buffer.record(
      toolResult(CLIENT_CALL_ID, '{"result": "Rename it to tmp2."}'),
    );
    const done = turn.step(clientToolDoneStep());

    expect(responses(done)).toEqual([
      ['naming_reviewer', CLIENT_CALL_ID, {result: 'Rename it to tmp2.'}],
    ]);
    expect(done[0].author).toBe('naming_reviewer');
    expect(done[0].content?.role).toBe('user');
  });

  it('test_a_client_tool_result_arriving_after_its_done_step_is_flushed', () => {
    // Hook dispatch is backgrounded, so a result can land after its step.
    const buffer = new ToolResultBuffer();
    const turn = new Turn(buffer);

    turn.step(clientToolActiveStep());
    const done = turn.step(clientToolDoneStep());
    buffer.record(
      toolResult(CLIENT_CALL_ID, '{"result": "Rename it to tmp2."}'),
    );
    const flushed = turn.flush();

    expect(responses(done)).toEqual([]);
    expect(responses(flushed)).toEqual([
      ['naming_reviewer', CLIENT_CALL_ID, {result: 'Rename it to tmp2.'}],
    ]);
  });

  it('test_a_client_tool_result_drained_at_its_step_is_not_flushed_again', () => {
    // A duplicate function_response is as broken as a missing one.
    const buffer = new ToolResultBuffer();
    const turn = new Turn(buffer);

    turn.step(clientToolActiveStep());
    buffer.record(toolResult(CLIENT_CALL_ID, '{"result": "ok"}'));
    turn.step(clientToolDoneStep());

    expect(turn.flush()).toEqual([]);
  });

  it('test_a_failed_client_tool_reports_the_error_the_error_hook_captured', async () => {
    // The failure arrives on the on-tool-error hook, never on post-tool-call:
    // the harness routes a failed tool to exactly one of the two.
    const buffer = new ToolResultBuffer();
    const errors = createToolErrorCapture(buffer);
    const turn = new Turn(buffer);

    turn.step(clientToolActiveStep());
    await errors.run(
      new ToolFailure(
        'child agent exploded',
        'naming_reviewer',
        CLIENT_CALL_ID,
      ),
    );
    const done = turn.step(clientToolDoneStep());

    expect(responses(done)).toEqual([
      ['naming_reviewer', CLIENT_CALL_ID, {error: 'child agent exploded'}],
    ]);
  });

  it('test_a_built_in_is_answered_from_its_step_and_its_hook_copy_is_inert', () => {
    // The hook fires for builtins too, under an id this side never sees, so
    // the copy is neither drainable nor droppable by id here. The turn's clear
    // collects it.
    const buffer = new ToolResultBuffer();
    const turn = new Turn(buffer);

    turn.step(builtinToolStep('ACTIVE'));
    buffer.record(
      toolResult(BUILTIN_HOOK_CALL_ID, '{"result": "hook copy"}', 'view_file'),
    );
    const builtinDone = turn.step(builtinToolStep('DONE', 'file contents'));
    turn.step(clientToolActiveStep());
    buffer.record(toolResult(CLIENT_CALL_ID, '{"result": "ok"}'));
    const clientDone = turn.step(clientToolDoneStep());

    expect(responses(builtinDone)).toEqual([
      ['view_file', BUILTIN_CALL_ID, {result: 'file contents'}],
    ]);
    expect(responses(clientDone)).toEqual([
      ['naming_reviewer', CLIENT_CALL_ID, {result: 'ok'}],
    ]);
    expect(turn.flush()).toEqual([]);
    // The hook copy is still held, under the id only the hook ever sees.
    expect(buffer.take(new Set([BUILTIN_HOOK_CALL_ID]))).toHaveLength(1);
  });

  it('answers a built-in call once even if its terminal step repeats', () => {
    // A duplicate function_response is as broken as a missing one.
    const turn = new Turn();

    turn.step(builtinToolStep('ACTIVE'));
    turn.step(builtinToolStep('DONE', 'file contents'));

    expect(turn.step(builtinToolStep('DONE', 'file contents'))).toEqual([]);
  });

  it('test_a_stripped_step_with_nothing_buffered_yields_nothing', () => {
    // The banner text is the translator's, not the tool's, so it is no answer.
    const buffer = new ToolResultBuffer();
    const turn = new Turn(buffer);

    turn.step(clientToolActiveStep());

    expect(turn.step(clientToolDoneStep())).toEqual([]);
  });

  it('test_a_result_for_a_call_that_was_never_emitted_is_not_drained', () => {
    // A response may only follow the call it answers.
    const buffer = new ToolResultBuffer();
    const turn = new Turn(buffer);
    buffer.record(toolResult('never_called', '{"result": "ok"}'));

    expect(turn.step(clientToolDoneStep())).toEqual([]);
    expect(turn.flush()).toEqual([]);
  });

  it.each([
    [
      'wrapped_json_object_is_unwrapped',
      '{"result": "the child\'s answer"}',
      {result: "the child's answer"},
    ],
    [
      'any_json_object_passes_through',
      '{"stdout": "hi", "code": 0}',
      {stdout: 'hi', code: 0},
    ],
    [
      'malformed_json_degrades_to_the_raw_string',
      'Calling custom tool: not json {',
      {result: 'Calling custom tool: not json {'},
    ],
    ['json_str', '"bare string"', {result: 'bare string'}],
    ['json_array_is_wrapped', '[1, 2]', {result: [1, 2]}],
    ['dict', {already: 'a dict'}, {already: 'a dict'}],
    ['none_is_not_null', null, {result: 'success'}],
    ['undefined_is_not_null', undefined, {result: 'success'}],
  ])(
    'test_a_buffered_result_becomes_a_dict_payload [%s]',
    (_id, value, expected) => {
      // `FunctionResponse.response` must be an object, whatever the tool
      // returned.
      const buffer = new ToolResultBuffer();
      const turn = new Turn(buffer);

      turn.step(clientToolActiveStep());
      buffer.record(toolResult(CLIENT_CALL_ID, value));
      const done = turn.step(clientToolDoneStep());

      expect(responses(done)).toEqual([
        ['naming_reviewer', CLIENT_CALL_ID, expected],
      ]);
    },
  );

  it('test_duplicate_tool_call_emitted_once', () => {
    // The same tool call repeated across steps is emitted only once.
    const step: AntigravityStep = {
      stepIndex: 1,
      type: 'TOOL_CALL',
      source: 'MODEL',
      toolCalls: [{name: 'view_file', args: {}, id: 'c1'}],
    };
    const turn = new Turn();

    const first = turn.step(step);
    const second = turn.step(step);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('synthesizes a call id from the step index when the SDK omits one', () => {
    const events = convert({
      stepIndex: 7,
      type: 'TOOL_CALL',
      source: 'MODEL',
      toolCalls: [{name: 'view_file'}],
    });

    expect(events[0].content?.parts?.[0].functionCall?.id).toBe('7-view_file');
  });

  it('reads a missing step index as zero when it synthesizes a call id', () => {
    const events = convert({
      type: 'TOOL_CALL',
      source: 'MODEL',
      toolCalls: [{name: 'view_file'}],
    });

    expect(events[0].content?.parts?.[0].functionCall?.id).toBe('0-view_file');
  });

  it('test_incomplete_text_step_produces_no_final_event', () => {
    // A non-final text step yields nothing in non-streaming mode.
    expect(
      convert({
        stepIndex: 0,
        type: 'TEXT_RESPONSE',
        source: 'MODEL',
        content: '',
      }),
    ).toEqual([]);
  });

  it('test_streaming_emits_partial_thinking_then_text_deltas', () => {
    const events = convert(
      {
        stepIndex: 0,
        type: 'TEXT_RESPONSE',
        source: 'MODEL',
        thinkingDelta: 'thinking...',
        contentDelta: 'hello',
      },
      true,
    );

    expect(events).toHaveLength(2);
    expect(events[0].partial).toBe(true);
    expect(events[0].content?.parts?.[0].thought).toBe(true);
    expect(events[0].content?.parts?.[0].text).toBe('thinking...');
    expect(events[1].partial).toBe(true);
    expect(events[1].content?.parts?.[0].text).toBe('hello');
  });

  it('test_non_streaming_omits_partial_deltas', () => {
    expect(
      convert({
        stepIndex: 0,
        type: 'TEXT_RESPONSE',
        source: 'MODEL',
        thinkingDelta: 'thinking...',
        contentDelta: 'hello',
      }),
    ).toEqual([]);
  });

  it('test_streaming_completed_step_emits_partial_then_final', () => {
    const events = convert(
      {
        stepIndex: 1,
        type: 'TEXT_RESPONSE',
        source: 'MODEL',
        contentDelta: ' world',
        content: 'hello world',
        isCompleteResponse: true,
      },
      true,
    );

    expect(events).toHaveLength(2);
    expect(events[0].partial).toBe(true);
    expect(events[0].content?.parts?.[0].text).toBe(' world');
    expect(events[1].partial).toBeFalsy();
    expect(events[1].content?.parts?.[0].text).toBe('hello world');
  });

  it('emits no partial deltas for a step the model did not produce', () => {
    expect(
      convert(
        {
          stepIndex: 0,
          type: 'TEXT_RESPONSE',
          source: 'SYSTEM',
          thinkingDelta: 'thinking...',
          contentDelta: 'hello',
        },
        true,
      ),
    ).toEqual([]);
  });

  it('treats a step with no type as UNKNOWN model text', () => {
    // The SDK defaults `type` to UNKNOWN, which counts as model text.
    const events = convert({
      source: 'MODEL',
      content: 'hello',
      isCompleteResponse: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0].text).toBe('hello');
  });
});

/** Builds an ADK event; `parts` omitted means the event carries no content. */
function event(author = 'agy', partial = false, parts?: Part[]): Event {
  return createEvent({
    invocationId: 'inv_1',
    author,
    partial,
    content: parts === undefined ? undefined : {role: 'model', parts},
  });
}

const TEXT_PART: Part = {text: 'answer'};
const THOUGHT_PART: Part = {text: 'thinking out loud', thought: true};
const CALL_PART: Part = {functionCall: {name: 'run_command', args: {}}};
const RESPONSE_PART: Part = {
  functionResponse: {name: 'run_command', response: {result: 'ok'}},
};

describe('finalModelText', () => {
  it.each([
    ['text', event('agy', false, [TEXT_PART]), 'answer'],
    [
      'text_parts_joined_with_newline',
      event('agy', false, [TEXT_PART, TEXT_PART]),
      'answer\nanswer',
    ],
    [
      'thought_dropped_text_kept',
      event('agy', false, [THOUGHT_PART, TEXT_PART]),
      'answer',
    ],
    ['partial', event('agy', true, [TEXT_PART]), undefined],
    ['thought_only', event('agy', false, [THOUGHT_PART]), undefined],
    ['function_call_only', event('agy', false, [CALL_PART]), undefined],
    [
      'function_response_from_tool',
      event('run_command', false, [RESPONSE_PART]),
      undefined,
    ],
    ['wrong_author', event('some_other_agent', false, [TEXT_PART]), undefined],
    ['empty_parts', event('agy', false, []), undefined],
    ['no_content', event('agy', false, undefined), undefined],
    [
      'content_without_parts',
      createEvent({
        invocationId: 'inv_1',
        author: 'agy',
        content: {role: 'model'},
      }),
      undefined,
    ],
  ])('test_final_model_text_filters [%s]', (_id, given, expected) => {
    // Only this agent's own, complete, user-visible text counts.
    expect(finalModelText(given, 'agy')).toBe(expected);
  });

  it('test_final_model_text_without_an_author_accepts_any_author', () => {
    expect(finalModelText(event('some_other_agent', false, [TEXT_PART]))).toBe(
      'answer',
    );
  });
});
