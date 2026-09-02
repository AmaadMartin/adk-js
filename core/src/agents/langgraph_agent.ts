/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseMessage} from '@langchain/core/messages';
import {createHash} from 'node:crypto';

import {createEvent, Event} from '../events/event.js';
import {loadOptionalPeer, OptionalPeer} from '../utils/optional_peer.js';
import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

/** The author ADK stamps on events that carry end-user input. */
const USER_AUTHOR = 'user';

/**
 * The optional peer holding the LangChain message classes.
 *
 * LangGraph graphs are built from LangChain messages, so an application that
 * uses {@link LangGraphAgent} already depends on `@langchain/core`. Every
 * other application would download it for nothing, so it is loaded on first
 * run instead of at import time.
 */
const LANGCHAIN_CORE: OptionalPeer = {
  packageName: '@langchain/core',
  feature: 'LangGraphAgent',
};

/** The LangChain message classes {@link LangGraphAgent} constructs. */
type MessageClasses = Pick<
  typeof import('@langchain/core/messages'),
  'AIMessage' | 'HumanMessage' | 'SystemMessage'
>;

/**
 * LangGraph's thread addressing config.
 *
 * `thread_id` is snake_case because it is LangGraph's own wire field, not an
 * adk-js field name.
 */
export interface LangGraphThreadConfig {
  configurable: {thread_id: string};
}

/**
 * The subset of a compiled LangGraph graph that {@link LangGraphAgent} uses.
 *
 * Declared structurally so that `@google/adk` never imports
 * `@langchain/langgraph`; a real `CompiledStateGraph` satisfies it.
 */
export interface CompiledLangGraph {
  /** Present and truthy when the graph was compiled with a checkpointer. */
  checkpointer?: unknown;
  getState(
    config: LangGraphThreadConfig,
  ): Promise<{values?: Record<string, unknown>}>;
  invoke(
    input: {messages: BaseMessage[]},
    config: LangGraphThreadConfig,
  ): Promise<{messages: BaseMessage[]}>;
}

/** The configuration options for creating a LangGraph agent. */
export interface LangGraphAgentConfig extends BaseAgentConfig {
  /** The compiled LangGraph state graph to adapt. */
  graph: CompiledLangGraph;
  /** System instruction prepended to the conversation. Defaults to `''`. */
  instruction?: string;
}

/**
 * A unique symbol to identify ADK LangGraph agent classes.
 * Defined once and shared by all LangGraphAgent instances.
 */
const LANG_GRAPH_AGENT_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.langGraphAgent',
);

/**
 * Type guard to check if an object is an instance of LangGraphAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of LangGraphAgent, false
 *   otherwise.
 */
export function isLangGraphAgent(obj: unknown): obj is LangGraphAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    LANG_GRAPH_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[LANG_GRAPH_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Derives the LangGraph checkpointer thread id for a session.
 *
 * Session ids are caller-chosen and are only unique within an
 * (app name, user id) pair, so all three components take part in the thread
 * id. Each component is length-prefixed before hashing so that a component
 * containing the separator cannot stand in for a different triple. The
 * composite is hashed rather than used verbatim so that the thread id is a
 * fixed-length token no checkpointer backend has to escape, and so the user id
 * is not written into checkpointer storage; the cost is that a stored row can
 * only be tied back to a session by recomputing the digest.
 *
 * The prefix counts code points, matching Python's `len()` on a string, so
 * that both SDKs derive the same thread id for the same session.
 */
function getThreadId(
  appName: string,
  userId: string,
  sessionId: string,
): string {
  const key = [appName, userId, sessionId]
    .map((component) => `${[...component].length}:${component}`)
    .join('|');
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Reports whether the thread's checkpointed state already holds messages.
 *
 * Only meaningful for a graph compiled with a checkpointer; a graph without
 * one keeps no state to read.
 */
async function hasCheckpointedMessages(
  graph: CompiledLangGraph,
  config: LangGraphThreadConfig,
): Promise<boolean> {
  const state = await graph.getState(config);
  const messages = state.values?.['messages'];
  return Array.isArray(messages) && messages.length > 0;
}

/**
 * Extracts the trailing run of user messages from the given events.
 *
 * The walk runs backwards and stops at the first non-user event that follows
 * a user message, so an agent turn appended after the user's last message does
 * not stop it.
 */
function getLastHumanMessages(
  events: Event[],
  {HumanMessage}: MessageClasses,
): BaseMessage[] {
  const messages: BaseMessage[] = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (messages.length > 0 && event.author !== USER_AUTHOR) {
      break;
    }
    if (event.author === USER_AUTHOR && event.content?.parts?.length) {
      messages.push(new HumanMessage(event.content.parts[0].text ?? ''));
    }
  }
  return messages.reverse();
}

/**
 * Extracts the whole conversation between the user and the named agent.
 *
 * Events authored by any other agent are dropped: they belong to a different
 * agent's turn, not to this graph's conversation.
 */
function getConversationWithAgent(
  events: Event[],
  agentName: string,
  {AIMessage, HumanMessage}: MessageClasses,
): BaseMessage[] {
  const messages: BaseMessage[] = [];
  for (const event of events) {
    if (!event.content?.parts?.length) {
      continue;
    }
    const text = event.content.parts[0].text ?? '';
    if (event.author === USER_AUTHOR) {
      messages.push(new HumanMessage(text));
    } else if (event.author === agentName) {
      messages.push(new AIMessage(text));
    }
  }
  return messages;
}

/**
 * Adapts a compiled LangGraph state graph for single or multi-turn use.
 *
 * The graph runs once per invocation and the agent yields a single event
 * carrying the text of the graph's last message. The graph's intermediate
 * messages are not turned into events.
 *
 * Which conversation reaches the graph depends on how the graph was compiled.
 * A graph compiled with a checkpointer owns its own memory, so only the
 * trailing user messages are forwarded, and the instruction is sent only while
 * the checkpointed state is still empty. A graph compiled without one gets the
 * whole user/agent conversation replayed on every turn.
 *
 * When using a persistent checkpointer, set `LANGGRAPH_STRICT_MSGPACK=true`
 * before importing LangGraph and compiling the graph. LangGraph's patched
 * releases provide schema-derived checkpoint allowlisting, but do not enable
 * strict deserialization by default.
 *
 * The checkpointer thread id is derived from the session's app name, user id
 * and id together, because session ids are only unique within an
 * (app name, user id) pair. Checkpoints written by earlier releases, which
 * keyed the thread on the session id alone, are not reused: with a persistent
 * checkpointer the first turn after upgrading resumes from empty graph state.
 *
 * ```ts
 * const agent = new LangGraphAgent({
 *   name: 'weather_agent',
 *   description: 'Answers weather questions',
 *   instruction: 'You are a weather assistant.',
 *   graph,
 * });
 * ```
 */
export class LangGraphAgent extends BaseAgent<LangGraphAgentConfig> {
  /**
   * A unique symbol to identify ADK LangGraph agent class.
   */
  readonly [LANG_GRAPH_AGENT_SIGNATURE_SYMBOL] = true;

  readonly graph: CompiledLangGraph;

  readonly instruction: string;

  constructor(config: LangGraphAgentConfig) {
    super(config);
    this.graph = config.graph;
    this.instruction = config.instruction ?? '';
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const {session} = context;
    const config: LangGraphThreadConfig = {
      configurable: {
        thread_id: getThreadId(session.appName, session.userId, session.id),
      },
    };

    const messageClasses = await loadOptionalPeer(
      LANGCHAIN_CORE,
      () => import('@langchain/core/messages'),
    );

    const checkpointed = Boolean(this.graph.checkpointer);
    const hasGraphHistory =
      checkpointed && (await hasCheckpointedMessages(this.graph, config));

    const messages: BaseMessage[] = [];
    if (this.instruction && !hasGraphHistory) {
      messages.push(new messageClasses.SystemMessage(this.instruction));
    }
    messages.push(
      ...(checkpointed
        ? getLastHumanMessages(session.events, messageClasses)
        : getConversationWithAgent(session.events, this.name, messageClasses)),
    );

    const finalState = await this.graph.invoke({messages}, config);
    const result = finalState.messages[finalState.messages.length - 1].text;

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: result}]},
    });
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    throw new Error('Live mode is not supported in LangGraphAgent.');
  }
}
