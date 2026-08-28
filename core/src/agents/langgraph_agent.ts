/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';

import type {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from '@langchain/core/messages';

import {createEvent, Event} from '../events/event.js';
import {loadOptionalPeer, OptionalPeer} from '../utils/optional_peer.js';

import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

const LANGCHAIN_CORE: OptionalPeer = {
  packageName: '@langchain/core',
  feature: 'LangGraphAgent',
};

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

  /**
   * `input` is `unknown` because the real signature takes a graph-specific
   * update type; any narrower hand-written object type would be assignable in
   * neither direction, even under the bivariance TypeScript applies to method
   * parameters.
   */
  invoke(
    input: unknown,
    config: LangGraphThreadConfig,
  ): Promise<{messages: Array<{content: unknown}>}>;
}

/** The configuration options for creating a LangGraph agent. */
export interface LangGraphAgentConfig extends BaseAgentConfig {
  /** The compiled LangGraph state graph to adapt. */
  graph: CompiledLangGraph;

  /** System instruction prepended to the conversation. Defaults to `''`. */
  instruction?: string;
}

/**
 * The LangChain message constructors, resolved lazily at run time so that
 * `@langchain/core` stays an optional dependency.
 */
interface MessageConstructors {
  AIMessage: typeof AIMessage;
  HumanMessage: typeof HumanMessage;
}

/** A `{type: 'text'}` block of a structured LangChain message content. */
interface TextContentBlock {
  type: 'text';
  text: string;
}

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

function isTextContentBlock(block: unknown): block is TextContentBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'text' &&
    'text' in block &&
    typeof block.text === 'string'
  );
}

/**
 * Extracts plain text from a LangChain message `content`, which is either a
 * string or a list of structured content blocks.
 */
function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(isTextContentBlock)
      .map((block) => block.text)
      .join('');
  }
  return '';
}

/**
 * Extracts the trailing run of user messages from the given events.
 *
 * Used when the graph owns the conversation memory, so that history already
 * held by the checkpointer is not replayed.
 */
function getLastHumanMessages(
  events: Event[],
  ctors: MessageConstructors,
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
  ctors: MessageConstructors,
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
 * `@langchain/langgraph` and `@langchain/core` are optional peer dependencies:
 * the graph is accepted structurally and the LangChain message constructors
 * are imported lazily, so importing `@google/adk` in a tree where neither is
 * installed never throws.
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
    let hasGraphHistory = false;
    if (hasCheckpointer) {
      const state = await this.graph.getState(config);
      const graphMessages = state.values?.['messages'];
      hasGraphHistory =
        Array.isArray(graphMessages) && graphMessages.length > 0;
    }

    const ctors = await loadOptionalPeer(
      LANGCHAIN_CORE,
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
        parts: [{text: messageText(lastMessage.content)}],
      },
    });
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    throw new Error('Live mode is not supported in LangGraphAgent.');
  }
}
