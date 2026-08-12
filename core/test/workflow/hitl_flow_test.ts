/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {
  hasRequestInputFunctionCall,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../../src/workflow/utils/hitl_utils.js';
import {reconstructNodeStates} from '../../src/workflow/utils/rehydration_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow} from './test_helpers.js';

/**
 * Drives a workflow, optionally supplying resume inputs (keyed by interrupt id).
 * Thin wrapper over the shared {@link driveWorkflow} for this file's positional
 * resume-input call sites.
 */
function drive(
  wf: Workflow,
  input?: unknown,
  resumeInputs: Record<string, unknown> = {},
): Promise<{output: unknown; interruptIds: string[]; events: Event[]}> {
  return driveWorkflow(wf, input, {resumeInputs});
}

describe('Phase 5 — HITL (pause / resume)', () => {
  it('pauses on RequestInput and surfaces the interrupt id', async () => {
    const approval = new FunctionNode('approval', (ctx) => {
      const answer = ctx.resumeInputs['approve-1'];
      if (answer === undefined) {
        return new RequestInput({
          interruptId: 'approve-1',
          message: 'Approve?',
        });
      }
      return `decided:${answer}`;
    });
    const wf = new Workflow({name: 'hitl', edges: [['START', approval]]});

    // Run 1: no resume input → interrupt.
    const paused = await drive(wf, undefined);
    expect(paused.interruptIds).toEqual(['approve-1']);
    expect(paused.output).toBeUndefined();
    // The interrupt surfaced as a request_input function-call event.
    expect(paused.events.some(hasRequestInputFunctionCall)).toBe(true);
    const fc = paused.events
      .flatMap((e) => e.content?.parts ?? [])
      .find((p) => p.functionCall?.name === REQUEST_INPUT_FUNCTION_CALL_NAME);
    expect(fc?.functionCall?.id).toBe('approve-1');
  });

  it('resumes and completes when the resume input is provided', async () => {
    const approval = new FunctionNode('approval', (ctx) => {
      const answer = ctx.resumeInputs['approve-1'];
      if (answer === undefined) {
        return new RequestInput({
          interruptId: 'approve-1',
          message: 'Approve?',
        });
      }
      return `decided:${answer}`;
    });
    const wf = new Workflow({name: 'hitl', edges: [['START', approval]]});

    // Run 2: provide the resume input → completes.
    const resumed = await drive(wf, undefined, {'approve-1': 'yes'});
    expect(resumed.interruptIds).toEqual([]);
    expect(resumed.output).toBe('decided:yes');
  });

  it('propagates an interrupt from a mid-graph node and halts downstream', async () => {
    const ran: string[] = [];
    const a = new FunctionNode('a', (_c, input) => {
      ran.push('a');
      return `a:${input}`;
    });
    const gate = new FunctionNode('gate', (ctx, input) => {
      ran.push('gate');
      const answer = ctx.resumeInputs['gate-1'];
      if (answer === undefined) {
        return new RequestInput({interruptId: 'gate-1', message: 'continue?'});
      }
      return `${input}|gate:${answer}`;
    });
    const c = new FunctionNode('c', (_c, input) => {
      ran.push('c');
      return `c:${input}`;
    });
    const wf = new Workflow({name: 'chain', edges: [['START', a, gate, c]]});

    const paused = await drive(wf, 'x');
    expect(paused.interruptIds).toEqual(['gate-1']);
    // Downstream node c must NOT have run while gate is waiting.
    expect(ran).toEqual(['a', 'gate']);

    const resumed = await drive(wf, 'x', {'gate-1': 'ok'});
    expect(resumed.output).toBe('c:a:x|gate:ok');
  });

  it('supports HITL in an imperative dynamicEntry workflow', async () => {
    // Re-entry HITL node: it re-runs on resume and reads the reply itself, so
    // it declares `rerunOnResume: true`. Under the default the dynamic
    // scheduler completes such a child with the raw reply as its output
    // instead of re-running it (the handoff form) — see
    // `dynamic_resume_test.ts` for both shapes driven through the Runner.
    //
    // Note this harness builds a fresh session per `drive()` call, so there
    // are no prior events to rehydrate from and neither cross-turn branch is
    // reached here; the flag is what the node means, not what this test
    // exercises.
    const ask = new FunctionNode(
      'ask',
      (ctx) => {
        const answer = ctx.resumeInputs['name'];
        if (answer === undefined) {
          return new RequestInput({interruptId: 'name', message: 'Your name?'});
        }
        return answer;
      },
      {rerunOnResume: true},
    );
    const wf = new Workflow({
      name: 'dyn_hitl',
      dynamicEntry: async (ctx) => {
        const child = await ctx.runNode(ask);
        if (child.interruptIds.length > 0) {
          return undefined; // still waiting
        }
        return `hello ${child.output}`;
      },
    });

    const paused = await drive(wf);
    expect(paused.interruptIds).toEqual(['name']);

    const resumed = await drive(wf, undefined, {name: 'Ada'});
    expect(resumed.output).toBe('hello Ada');
  });

  it('rejects a wrongly-shaped reply to a session adk-python paused', () => {
    const schema = {
      type: 'object',
      properties: {approved: {type: 'boolean'}},
      required: ['approved'],
    };
    const events = [
      createEvent({
        author: 'gate',
        nodeInfo: {path: 'wf.gate'},
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: REQUEST_INPUT_FUNCTION_CALL_NAME,
                id: 'gate-1',
                // The envelope `create_request_input_event` writes: camelCase
                // everywhere except the schema key.
                args: {
                  interruptId: 'gate-1',
                  payload: null,
                  message: 'Approve?',
                  response_schema: schema,
                },
              },
            },
          ],
        },
        longRunningToolIds: ['gate-1'],
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'gate-1',
                name: REQUEST_INPUT_FUNCTION_CALL_NAME,
                response: {response: 'yes'},
              },
            },
          ],
        },
      }),
    ];

    expect(() => reconstructNodeStates(events)).toThrow(
      /does not match the responseSchema it declared/,
    );
  });
});
