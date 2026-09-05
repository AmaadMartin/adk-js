/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the bridge exposing ADK sub-agents as Antigravity client tools.
 *
 * Ported from adk-python
 * `tests/unittests/labs/antigravity/test_sub_agent_tools.py` at `a119dd77`.
 * The `it(...)` names are the reference test names, verbatim.
 */

import {BaseAgent, createEvent, Event, InvocationContext} from '@google/adk';
import {makeSubAgentTool} from '@google/adk/labs/antigravity/sub_agent_tools.js';
import {describe, expect, it} from 'vitest';

/** Replies with the request it was given, prefixed. */
class EchoAgent extends BaseAgent {
  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    let text = '';
    for (const part of ctx.userContent?.parts ?? []) {
      if (part.text) {
        text = part.text;
      }
    }
    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: `echoed: ${text}`}]},
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    // Never driven: these agents exist for the text path only.
  }
}

describe('makeSubAgentTool', () => {
  it('test_the_tool_takes_its_name_and_docstring_from_the_child', () => {
    const child = new EchoAgent({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });

    const tool = makeSubAgentTool(child);

    expect(tool.name).toBe('reviewer');
    expect(tool.description).toBe('Reviews a diff.');
  });

  it('test_the_request_reaches_the_child_and_its_text_comes_back', async () => {
    const child = new EchoAgent({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });

    const tool = makeSubAgentTool(child);

    await expect(tool.run('look at the patch')).resolves.toBe(
      'echoed: look at the patch',
    );
  });

  it('test_the_last_text_the_child_emits_is_the_one_returned', async () => {
    /** Emits three separate final-text events, so only the last should win. */
    class ChattyAgent extends BaseAgent {
      protected async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        for (const text of ['first', 'second', 'third']) {
          yield createEvent({
            invocationId: ctx.invocationId,
            author: this.name,
            content: {role: 'model', parts: [{text}]},
          });
        }
      }

      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        // Never driven: these agents exist for the text path only.
      }
    }
    const child = new ChattyAgent({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });

    const tool = makeSubAgentTool(child);

    await expect(tool.run('look at the patch')).resolves.toBe('third');
  });

  it('test_multiple_text_parts_are_joined_with_newlines', async () => {
    /** Emits one event whose content carries two separate text parts. */
    class TwoPartAgent extends BaseAgent {
      protected async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        yield createEvent({
          invocationId: ctx.invocationId,
          author: this.name,
          content: {role: 'model', parts: [{text: 'Hello'}, {text: 'world'}]},
        });
      }

      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        // Never driven: these agents exist for the text path only.
      }
    }
    const child = new TwoPartAgent({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });

    const tool = makeSubAgentTool(child);

    await expect(tool.run('look at the patch')).resolves.toBe('Hello\nworld');
  });

  it('test_a_child_with_no_visible_text_returns_the_empty_string', async () => {
    /** Emits only a thought, which is not user-visible model text. */
    class SilentAgent extends BaseAgent {
      protected async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        yield createEvent({
          invocationId: ctx.invocationId,
          author: this.name,
          content: {
            role: 'model',
            parts: [{text: 'thinking out loud', thought: true}],
          },
        });
      }

      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        // Never driven: these agents exist for the text path only.
      }
    }
    const child = new SilentAgent({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });

    const tool = makeSubAgentTool(child);

    // Explicit, because the harness needs a string and `undefined` — the
    // regression this test exists to catch — is falsy too.
    await expect(tool.run('look at the patch')).resolves.toBe('');
  });

  it('test_a_composite_child_answers_with_its_sub_agents_text', async () => {
    /** Runs its children in order, as any composite ADK agent does. */
    class PipelineAgent extends BaseAgent {
      protected async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        for (const subAgent of this.subAgents) {
          yield* subAgent.runAsync(ctx);
        }
      }

      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        // Never driven: these agents exist for the text path only.
      }
    }
    // Events come back authored 'inner', never 'pipeline'. Filtering on the
    // child's own name would match nothing and quietly answer ''.
    const child = new PipelineAgent({
      name: 'pipeline',
      description: 'Reviews a diff in stages.',
      subAgents: [new EchoAgent({name: 'inner', description: 'Echoes.'})],
    });

    const tool = makeSubAgentTool(child);

    await expect(tool.run('look at the patch')).resolves.toBe(
      'echoed: look at the patch',
    );
  });

  it('test_a_blocked_child_answers_with_its_error_message', async () => {
    /** Emits an error and no content at all, as a blocked model turn does. */
    class BlockedAgent extends BaseAgent {
      protected async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        yield createEvent({
          invocationId: ctx.invocationId,
          author: this.name,
          errorMessage: 'blocked by the safety filter',
        });
      }

      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        // Never driven: these agents exist for the text path only.
      }
    }
    const child = new BlockedAgent({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });

    const tool = makeSubAgentTool(child);

    await expect(tool.run('look at the patch')).resolves.toBe(
      'blocked by the safety filter',
    );
  });

  it('test_a_failing_child_propagates', async () => {
    /** Always fails, to prove failures are not swallowed. */
    class AngryAgent extends BaseAgent {
      // Not a generator: the return type is BaseAgent's contract, and this
      // agent only ever throws.
      protected runAsyncImpl(): AsyncGenerator<Event, void, void> {
        throw new Error('child exploded');
      }

      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        // Never driven: these agents exist for the text path only.
      }
    }
    const child = new AngryAgent({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });

    const tool = makeSubAgentTool(child);

    await expect(tool.run('look at the patch')).rejects.toThrow(
      'child exploded',
    );
  });
});
