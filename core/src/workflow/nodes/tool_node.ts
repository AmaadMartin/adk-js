/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionCall} from '@google/genai';
import {handleFunctionCallList} from '../../agents/functions.js';
import {Event} from '../../events/event.js';
import {isDefaultEventActions} from '../../events/event_actions.js';
import {getFunctionResponses} from '../../models/llm_response.js';
import {BaseTool} from '../../tools/base_tool.js';
import {isContent} from '../../utils/content_utils.js';
import {BaseNode, BaseNodeConfig} from '../base_node.js';
import {NodeContext} from '../node_context.js';

/** Options for a {@link ToolNode}. */
export interface ToolNodeConfig extends Partial<Omit<BaseNodeConfig, 'name'>> {
  /** Optional name override; defaults to the tool's name. */
  name?: string;
}

/**
 * A node that wraps an ADK {@link BaseTool} and invokes it with the node input
 * as its arguments.
 *
 * Ported from `google/adk-python` `workflow/_tool_node.py`. The node input is
 * coerced to a tool-args object: genai `Content` → its text; a JSON string →
 * parsed object; `null`/empty → `{}`.
 *
 * The tool runs through the canonical execution path
 * ({@link handleFunctionCallList}), so the plugin `before`/`after`/`onError`
 * tool callbacks, the confirmation gate, telemetry, and everything the tool
 * writes to its context (`stateDelta`, `artifactDelta`, requested credentials /
 * confirmations, …) all apply — exactly as when the same tool is called from an
 * LLM agent.
 *
 * A tool that returns a response yields an event carrying a canonical
 * `functionResponse` part, and the response becomes the node output. A tool
 * that returns nothing — including a long-running tool deferring its response
 * — yields a bare event carrying whatever it recorded, or no event at all when
 * it recorded nothing.
 */
export class ToolNode extends BaseNode {
  readonly tool: BaseTool;

  constructor(tool: BaseTool, config: ToolNodeConfig = {}) {
    // Spread first so an explicit `undefined` name in `config` can't clobber
    // the fallback (which BaseNode requires to be non-empty).
    super({...config, name: config.name ?? tool.name});
    this.tool = tool;
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<Event, void, void> {
    // Coerce the node input into a tool-args object, then re-validate it against
    // `inputSchema`. BaseNode.validateInput skips genai `Content` up front (a
    // node coerces it itself), so this is the only point model-authored args are
    // checked before reaching the tool.
    const args = this.validateInput(coerceToolArgs(input)) as Record<
      string,
      unknown
    >;

    // Deterministic id so credential/confirmation requests can be matched to
    // their resume response across turns/retries (a fresh UUID never would).
    const functionCall: FunctionCall = {
      name: this.tool.name,
      args,
      id: `${ctx.nodePath}:${ctx.runId}`,
    };

    const responseEvent = await handleFunctionCallList({
      invocationContext: ctx.invocationContext,
      functionCalls: [functionCall],
      toolsDict: {[this.tool.name]: this.tool},
      // Plugin callbacks still run via invocationContext.pluginManager; there is
      // no agent-level tool-callback list on a workflow node.
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    if (!responseEvent) {
      return;
    }
    responseEvent.author = this.name;

    const response = toolResponse(responseEvent);
    if (response !== undefined) {
      // Surface the tool's (post-callback) response as the node output so it
      // can drive downstream nodes, while the event keeps its canonical
      // functionResponse content for history.
      responseEvent.output = response;
      yield responseEvent;
      return;
    }

    // No response: match adk-python `_tool_node`, which yields a state-only
    // event or nothing rather than an output the successor node would read.
    if (!isDefaultEventActions(responseEvent.actions)) {
      // Drop the `{result: <nullish>}` part so the event carries only what the
      // tool recorded. A deferred long-running response has no content already.
      responseEvent.content = undefined;
      yield responseEvent;
    }
  }
}

/**
 * The tool's post-callback response, or `undefined` when it produced none.
 *
 * `agents/functions.ts` wraps a nullish tool result as `{result: <nullish>}`
 * and emits an actions-only event (no function-response part) for a
 * long-running tool that defers its response; both mean "no response".
 *
 * A tool that returns the object `{result: null}` reads as "no response" too.
 * adk-python's `_tool_node` tests `response is not None` against the raw return
 * and so keeps the two apart, but the wrap above erases the difference before
 * this function runs. Separating them needs a second return channel on
 * {@link handleFunctionCallList}, which merges N calls into one event and has
 * no well-defined per-call result to expose.
 */
function toolResponse(event: Event): Record<string, unknown> | undefined {
  const response = getFunctionResponses(event)[0]?.response;
  if (response == null) {
    return undefined;
  }
  const keys = Object.keys(response);
  if (keys.length === 1 && keys[0] === 'result' && response['result'] == null) {
    return undefined;
  }
  return response;
}

/** Coerces arbitrary node input into a tool-arguments record. */
function coerceToolArgs(input: unknown): Record<string, unknown> {
  let args: unknown = input;

  if (isContent(args)) {
    args = extractText(args);
  }

  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) {
      args = null;
    } else {
      try {
        args = JSON.parse(trimmed);
      } catch {
        // Leave as the raw string; rejected below.
      }
    }
  }

  if (args === null || args === undefined) {
    return {};
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError(
      'The input to ToolNode must be an object of tool arguments or null, ' +
        `but got ${typeof args}.`,
    );
  }
  return args as Record<string, unknown>;
}

function extractText(content: {parts?: Array<{text?: string}>}): string {
  return (content.parts ?? []).map((p) => p.text ?? '').join('');
}

// The builder that turns a BaseTool into a ToolNode is wired into the static
// NODE_BUILDERS list in ../node_builders.ts.
