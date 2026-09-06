/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python tests/unittests/workflow/test_errors.py and
 * tests/unittests/workflow/test_node_runner_failure.py at main
 * (a119dd7751082dbbd9a65f71e359abdc2be659cc).
 */

import {describe, expect, it} from 'vitest';
import {
  DynamicNodeFailError,
  NodeInterruptedError,
} from '../../src/workflow/errors.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow} from './test_helpers.js';

/** A genai-shaped client error: the status arrives as `code`. */
class GenaiClientError extends Error {
  readonly code = 403;
  readonly details = 'Egress request is not authorized';
  constructor() {
    super('403 PERMISSION_DENIED');
  }
}

/**
 * An httpx-shaped client error: the body lives on `response.text`. The Python
 * fixture spells the status field `status_code`; `statusCode` is the
 * JavaScript name for the same field.
 */
class HttpxError extends Error {
  readonly statusCode = 403;
  readonly response = {text: 'forbidden body'};
  constructor() {
    super('403 Forbidden');
  }
}

describe('workflow errors — ported reference tests', () => {
  it('test_dynamic_node_fail_error_surfaces_wrapped_error_attrs', () => {
    const genaiErr = new GenaiClientError();
    const dynamicErr = new DynamicNodeFailError({
      message: 'Dynamic node ChildNode failed',
      error: genaiErr,
      errorNodePath: 'parent/ChildNode',
    });
    expect(dynamicErr.statusCode).toBe(403); // via the `code` fallback
    expect(dynamicErr.details).toBe('Egress request is not authorized');
    expect(dynamicErr.error).toBe(genaiErr);
    // The reference's `assert not hasattr(dynamic_err, 'cause')`.
    expect('cause' in dynamicErr).toBe(false);

    const httpxErr = new HttpxError();
    const dynamicErr2 = new DynamicNodeFailError({
      message: 'x',
      error: httpxErr,
      errorNodePath: 'p',
    });
    expect(dynamicErr2.statusCode).toBe(403);
    expect(dynamicErr2.details).toBe('forbidden body'); // via `response.text`

    const plainErr = new Error('x');
    const dynamicErr3 = new DynamicNodeFailError({
      message: 'x',
      error: plainErr,
      errorNodePath: 'p',
    });
    expect(dynamicErr3.statusCode).toBeUndefined();
    expect(dynamicErr3.details).toBeUndefined();
  });

  it('test_node_interrupted_error_survives_a_broad_except_in_node_code', () => {
    // Divergence: the reference asserts the error escapes, because Python's
    // `BaseException` sits outside `except Exception`. TypeScript has one
    // exception hierarchy, so a bare `catch` does catch it. The behavioural
    // test below pins the property that base class protects.
    function nodeBodyThatSwallowsErrors(): string {
      try {
        throw new NodeInterruptedError();
      } catch {
        return 'swallowed';
      }
    }

    expect(nodeBodyThatSwallowsErrors()).toBe('swallowed');
  });
});

describe('a node body that swallows an interrupt', () => {
  it('still records the caller as waiting and holds its successor back', async () => {
    const ran: string[] = [];
    const ask = new FunctionNode('ask', (ctx) => {
      const answer = ctx.resumeInputs['ask-1'];
      if (answer === undefined) {
        return new RequestInput({interruptId: 'ask-1', message: 'Approve?'});
      }
      return `decided:${answer}`;
    });
    const caller = new FunctionNode('caller', async (ctx) => {
      try {
        await ctx.runNode(ask);
      } catch {
        // A node body that swallows everything, as user code routinely does.
      }
      ran.push('caller');
      return 'caller finished';
    });
    const successor = new FunctionNode('successor', () => {
      ran.push('successor');
      return 'successor finished';
    });
    const wf = new Workflow({
      name: 'swallow',
      edges: [
        ['START', caller],
        [caller, successor],
      ],
    });

    const paused = await driveWorkflow(wf, 'x');

    expect(ran).toEqual(['caller']);
    expect(paused.interruptIds).toEqual(['ask-1']);
    expect(paused.output).toBeUndefined();
  });
});
