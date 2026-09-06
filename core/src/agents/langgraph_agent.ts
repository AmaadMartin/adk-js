/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';

import type {BaseMessage} from '@langchain/core/messages';

import {createEvent, Event} from '../events/event.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

/**
 * The LangGraph thread configuration used to address a conversation thread.
 *
 * `thread_id` is snake_case because it is LangGraph's own wire contract, not
 * an adk-js field name.
 */
export interface LangGraphThreadConfig {
  configurable: {thread_id: string};
}

/**
 * Derives the LangGraph checkpointer thread id for a session.
 *
 * Session ids are caller-chosen and are only unique within an
 * (app name, user id) pair, so all three components take part in the thread
 * id. Each component is length-prefixed before hashing, so a component that
 * contains the separator cannot stand in for a different triple. The
 * composite is hashed rather than used verbatim, so the thread id is a
 * fixed-length token that no checkpointer backend has to escape, and the user
 * id is not written into checkpointer storage. The cost is that a stored row
 * can only be tied back to a session by recomputing the digest.
 *
 * The length prefix counts code points, not UTF-16 code units, so adk-js and
 * adk-python derive the same thread id for the same session.
 *
 * Not part of the package's public API, like adk-python's `_get_thread_id`,
 * which leaves the scheme free to change. adk-python has already changed it
 * once.
 *
 * @param appName The app the session belongs to.
 * @param userId The user the session belongs to.
 * @param sessionId The session id.
 * @returns A deterministic thread id for the session.
 */
export function getThreadId(
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
 * The `@langchain/core` message module, resolved lazily at run time so that
 * the package stays an optional dependency.
 */
type LangChainMessages = typeof import('@langchain/core/messages');

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all LangGraphAgent instances.
 */
const LANGGRAPH_AGENT_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.langGraphAgent',
);

/**
 * Type guard to check if an object is an instance of LangGraphAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of LangGraphAgent, false
 *     otherwise.
 */
export function isLangGraphAgent(obj: unknown): obj is LangGraphAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    LANGGRAPH_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[LANGGRAPH_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Extracts the trailing run of user messages from the given events.
 *
 * Used when the graph owns the conversation memory, so that history already
 * held by the checkpointer is not replayed.
 */
function getLastHumanMessages(
  events: Event[],
  ctors: LangChainMessages,
): BaseMessage[] {
  const messages: BaseMessage[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (messages.length > 0 && event.author !== 'user') {
      break;
    }
    if (event.author === 'user' && event.content?.parts?.length) {
      messages.push(new ctors.HumanMessage(event.content.parts[0].text ?? ''));
    }
  }
  return messages.reverse();
}

/**
 * Extracts the whole conversation between the user and the named agent from
 * the given events, dropping events authored by anyone else.
 */
function getConversationWithAgent(
  events: Event[],
  agentName: string,
  ctors: LangChainMessages,
): BaseMessage[] {
  const messages: BaseMessage[] = [];
  for (const event of events) {
    if (!event.content?.parts?.length) {
      continue;
    }
    const text = event.content.parts[0].text ?? '';
    if (event.author === 'user') {
      messages.push(new ctors.HumanMessage(text));
    } else if (event.author === agentName) {
      messages.push(new ctors.AIMessage(text));
    }
  }
  return messages;
}

/**
 * Adapts a compiled LangGraph state graph for single or multi-turn use.
 *
 * `@langchain/core` is an optional peer dependency, loaded lazily; the graph is
 * accepted structurally, so `@google/adk` never imports `@langchain/langgraph`
 * at all.
 *
 * Each run yields one event carrying the graph's last message; the graph's
 * intermediate messages do not become events. Live mode is not supported.
 */
export class LangGraphAgent extends BaseAgent<LangGraphAgentConfig> {
  /**
   * A unique symbol to identify ADK LangGraph agent class.
   */
  readonly [LANGGRAPH_AGENT_SIGNATURE_SYMBOL] = true;

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
    const config: LangGraphThreadConfig = {
      configurable: {
        thread_id: getThreadId(
          context.session.appName,
          context.session.userId,
          context.session.id,
        ),
      },
    };

    const hasCheckpointer = Boolean(this.graph.checkpointer);

    // The graph only holds state that can be read back when it was compiled
    // with a checkpointer.
    const graphMessages = hasCheckpointer
      ? (await this.graph.getState(config)).values?.['messages']
      : undefined;
    const hasGraphHistory =
      Array.isArray(graphMessages) && graphMessages.length > 0;

    const ctors = await loadOptionalPeer(
      {packageName: '@langchain/core', feature: 'LangGraphAgent'},
      () => import('@langchain/core/messages'),
    );

    const messages: BaseMessage[] = [];
    if (this.instruction && !hasGraphHistory) {
      messages.push(new ctors.SystemMessage(this.instruction));
    }
    // A graph with its own memory has already replayed the conversation, so
    // only the new user messages are forwarded to it.
    messages.push(
      ...(hasCheckpointer
        ? getLastHumanMessages(context.session.events, ctors)
        : getConversationWithAgent(context.session.events, this.name, ctors)),
    );

    const finalState = await this.graph.invoke({messages}, config);
    const lastMessage = finalState.messages[finalState.messages.length - 1];

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        role: 'model',
        parts: [{text: lastMessage.text}],
      },
    });
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    throw new Error('Live mode is not supported in LangGraphAgent.');
  }
}
