/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {context, trace} from '@opentelemetry/api';

import {createEvent, Event} from '../events/event.js';
import type {EventActions} from '../events/event_actions.js';

import {
  runAsyncGeneratorWithOtelContext,
  traceAgentInvocation,
  tracer,
} from '../telemetry/tracing.js';
import {formatError} from '../utils/error_utils.js';
import {validateIdentifierName} from '../utils/identifier_utils.js';
import {logger} from '../utils/logger.js';
import {BaseNode, BaseNodeConfig} from '../workflow/base_node.js';
import type {NodeContext} from '../workflow/node_context.js';
import {Context} from './context.js';
import {InvocationContext} from './invocation_context.js';

/**
 * A single callback function for an agent.
 */
export type SingleAgentCallback = (
  context: Context,
) => Promise<Content | undefined> | (Content | undefined);

/**
 * Type for before agent callbacks, which can be a single callback or
 * an array of callbacks.
 */
export type BeforeAgentCallback = SingleAgentCallback | SingleAgentCallback[];

/**
 * Type for after agent callbacks, which can be a single callback or
 * an array of callbacks.
 */
export type AfterAgentCallback = SingleAgentCallback | SingleAgentCallback[];

/**
 * The config of a base agent.
 *
 * Extends {@link BaseNodeConfig}, so every agent also accepts the node-level
 * options — `retryConfig`, `timeout`, `inputSchema`, `outputSchema`,
 * `stateSchema`, `rerunOnResume`, `waitForOutput` — which apply when the agent
 * runs inside a workflow.
 */
export interface BaseAgentConfig extends BaseNodeConfig {
  name: string;
  description?: string;
  parentAgent?: BaseAgent;
  subAgents?: BaseAgent[];
  beforeAgentCallback?: BeforeAgentCallback;
  afterAgentCallback?: AfterAgentCallback;
}

/**
 * The resumption checkpoint an agent records for the current invocation.
 *
 * The base state is the empty object, meaning "this agent started but has
 * nothing more specific to restore". A concrete agent describes its own state
 * shape — which sub-agent was running, how many times a loop has run — and it
 * is persisted verbatim on `EventActions.agentState`, so this is an open JSON
 * record rather than a closed shape.
 *
 * Declare a concrete state with `type`, not `interface`: a TypeScript
 * `interface` has no implicit index signature and so is not assignable to
 * `Record<string, unknown>`.
 *
 * Mirrors adk-python `BaseAgentState`.
 */
export type BaseAgentState = Record<string, unknown>;

/**
 * The config keys every agent accepts, from {@link BaseAgentConfig} and the
 * {@link BaseNodeConfig} it extends.
 *
 * {@link BaseAgent.clone} checks an override key against this set plus the
 * instance's own keys, because TypeScript erases a subclass's config interface
 * and leaves no runtime field registry to check against. That check is
 * deliberately permissive: an internal instance field is accepted even though
 * it is not a config key. A false rejection would break working code, while a
 * false acceptance only fails to catch a typo.
 */
const BASE_AGENT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'parentAgent',
  'subAgents',
  'beforeAgentCallback',
  'afterAgentCallback',
  'rerunOnResume',
  'waitForOutput',
  'retryConfig',
  'timeout',
  'inputSchema',
  'outputSchema',
  'stateSchema',
  'isolationScope',
]);

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseAgent instances.
 */
const BASE_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.baseAgent');

/**
 * Type guard to check if an object is an instance of BaseAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseAgent, false otherwise.
 */
export function isBaseAgent(obj: unknown): obj is BaseAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[BASE_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Base class for all agents in Agent Development Kit.
 *
 * The class is generic over its config type so that {@link clone} can be typed
 * per subclass (e.g. `LlmAgent.clone({instruction})`). The default keeps bare
 * `BaseAgent` references valid as `BaseAgent<BaseAgentConfig>`.
 *
 * An agent **is** a {@link BaseNode}, so any agent can be dropped straight into
 * a workflow graph without a wrapper — mirroring adk-python, where
 * `BaseAgent(BaseNode)`. {@link runImpl} bridges the two contracts: the node
 * runner calls it, and it delegates to the agent's own {@link runAsync}.
 */
export abstract class BaseAgent<
  TConfig extends BaseAgentConfig = BaseAgentConfig,
> extends BaseNode {
  /**
   * A unique symbol to identify ADK agent classes.
   */
  readonly [BASE_AGENT_SIGNATURE_SYMBOL] = true;

  /**
   * The config this agent was constructed from.
   *
   * Stored so {@link clone} can rebuild the agent by re-running the concrete
   * constructor with overrides applied, which re-derives all state correctly
   * instead of copying an already-mutated instance. Shallow-copied so later
   * external mutation of the caller's object does not leak into clones.
   */
  protected readonly config: TConfig;

  /**
   * The agent's name.
   * Agent name must be a JS identifier and unique within the agent tree.
   * Agent name cannot be "user", since it's reserved for end-user's input.
   */
  readonly name: string;

  // `description` is inherited from BaseNode, which declares it `string` and
  // defaults it to ''. It used to be `string | undefined` here; every consumer
  // already coalesced (`agent.description || ''`), so the default is
  // equivalent for them.

  /**
   * Root agent of this agent.
   * Computed dynamically by traversing up the parent chain.
   */
  get rootAgent(): BaseAgent {
    return getRootAgent(this);
  }

  /**
   * The parent agent of this agent.
   *
   * Note that an agent can ONLY be added as sub-agent once.
   *
   * If you want to add one agent twice as sub-agent, consider to create two
   * agent instances with identical config, but with different name and add them
   * to the agent tree.
   *
   * The parent agent is the agent that created this agent.
   */
  parentAgent?: BaseAgent;

  /**
   * The sub-agents of this agent.
   */
  readonly subAgents: BaseAgent[];

  /**
   * Callback or list of callbacks to be invoked before the agent run.
   *
   * When a list of callbacks is provided, the callbacks will be called in the
   * order they are listed until a callback does not return undefined.
   *
   * @param callbackContext: MUST be named 'callbackContext' (enforced).
   *
   * @return Content: The content to return to the user. When the content is
   *     present, the agent run will be skipped and the provided content will be
   *     returned to user.
   */
  readonly beforeAgentCallback: SingleAgentCallback[];

  /**
   * Callback or list of callbacks to be invoked after the agent run.
   *
   * When a list of callbacks is provided, the callbacks will be called in the
   * order they are listed until a callback does not return undefined.
   *
   * @param callbackContext: MUST be named 'callbackContext' (enforced).
   *
   * @return Content: The content to return to the user. When the content is
   *     present, the provided content will be used as agent response and
   *     appended to event history as agent response.
   */
  readonly afterAgentCallback: SingleAgentCallback[];

  constructor(config: BaseAgentConfig) {
    // An agent name is stricter than a node name (a JS identifier, and never
    // "user"), so it is validated here and handed to BaseNode already checked.
    super({...config, name: validateAgentName(config.name)});
    // Captures every field the concrete subclass passed to super(...), even
    // though the parameter is typed BaseAgentConfig, so clone() can rebuild it.
    this.config = {...config} as TConfig;
    this.name = validateAgentName(config.name);
    this.parentAgent = config.parentAgent;
    this.subAgents = config.subAgents || [];
    this.beforeAgentCallback = getCannonicalCallback(
      config.beforeAgentCallback,
    );
    this.afterAgentCallback = getCannonicalCallback(config.afterAgentCallback);

    warnOnDuplicateSubAgentNames(this.subAgents);
    this.setParentAgentForSubAgents();
  }

  /**
   * Creates a copy of this agent with the given config fields overridden.
   *
   * Mirrors adk-python's `BaseAgent.clone(update=...)`. The clone is a detached
   * root: its `parentAgent` is always `undefined`. Sub-agents are recursively
   * cloned (and re-parented to the clone) unless `subAgents` is overridden.
   * Rebuilding via the concrete constructor re-derives all state, so a cloned
   * `LlmAgent` gets a fresh `requestProcessors` array rather than sharing the
   * original's. See google/adk-js#534.
   *
   * @param overrides Config fields to override on the clone. Overriding
   *     `parentAgent` is rejected, and an override key this agent cannot place
   *     is rejected, both matching adk-python.
   * @returns A new detached agent instance of the same concrete class.
   */
  clone(overrides?: Partial<TConfig>): this {
    if (overrides && 'parentAgent' in overrides) {
      throw new Error(
        'Cannot update `parentAgent` field in clone. Parent agent is set ' +
          'only when the parent agent is instantiated with the sub-agents.',
      );
    }

    this.validateOverrideKeys(overrides);

    const merged: TConfig = {...this.config, ...overrides};

    // A clone is always a detached root (matches adk-python setting parent to
    // None); the rebuilt parent constructor re-parents any cloned children.
    merged.parentAgent = undefined;

    // Shallow-copy any list-typed field not provided in overrides so the clone
    // never shares a mutable array (e.g. `tools`) with the original, mirroring
    // adk-python's per-field list copy.
    const mergedRecord = merged as Record<string, unknown>;
    for (const key of Object.keys(mergedRecord)) {
      if (key === 'subAgents' || (overrides && key in overrides)) {
        continue;
      }
      const value = mergedRecord[key];
      if (Array.isArray(value)) {
        mergedRecord[key] = value.slice();
      }
    }

    // Recursively clone sub-agents unless explicitly overridden, so the rebuilt
    // constructor re-parents fresh, unparented children instead of throwing
    // "already has a parent agent".
    if (!overrides || !('subAgents' in overrides)) {
      merged.subAgents = this.subAgents.map((subAgent) => subAgent.clone());
    }

    const ctor = this.constructor as new (config: TConfig) => this;
    return new ctor(merged);
  }

  /**
   * Config keys this agent accepts but never stores on the instance.
   *
   * {@link clone} cannot see a subclass's config interface, because TypeScript
   * erases it, so it derives the allowed override keys from the instance
   * instead. A subclass that consumes a config field without assigning it —
   * `LlmAgent` folds `contextCompactors` into its request processors — has to
   * name it here, or `clone()` rejects an override that the constructor would
   * have honoured.
   */
  protected get configOnlyKeys(): readonly string[] {
    return [];
  }

  /**
   * Rejects override keys this agent cannot place, so a typo fails loudly
   * instead of returning an unchanged clone.
   *
   * @param overrides The overrides passed to {@link clone}.
   * @throws If an override names a field this agent does not have.
   */
  private validateOverrideKeys(overrides?: Partial<TConfig>): void {
    if (!overrides) {
      return;
    }

    const allowed = new Set<string>([
      ...BASE_AGENT_CONFIG_KEYS,
      ...this.configOnlyKeys,
      ...Object.keys(this.config),
      ...Object.keys(this),
    ]);
    const invalid = Object.keys(overrides).filter((key) => !allowed.has(key));
    if (invalid.length > 0) {
      throw new Error(
        `Cannot update nonexistent fields in ${this.constructor.name}: ` +
          invalid.sort().join(', '),
      );
    }
  }

  /**
   * Entry method to run an agent via text-based conversation.
   *
   * @param parentContext The invocation context of the parent agent.
   * @yields The events generated by the agent.
   * @returns An AsyncGenerator that yields the events generated by the agent.
   */
  async *runAsync(
    parentContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const span = tracer.startSpan(`invoke_agent ${this.name}`);
    const ctx = trace.setSpan(context.active(), span);
    try {
      yield* runAsyncGeneratorWithOtelContext<BaseAgent, Event>(
        ctx,
        this,
        async function* () {
          // Built outside the try: without a context there is nothing to hand
          // the error callback.
          const context = this.createInvocationContext(parentContext);

          try {
            const beforeAgentCallbackEvent =
              await this.handleBeforeAgentCallback(context);
            if (beforeAgentCallbackEvent) {
              yield beforeAgentCallbackEvent;
            }

            if (context.endInvocation || parentContext.abortSignal?.aborted) {
              return;
            }

            traceAgentInvocation({agent: this, invocationContext: context});
            for await (const event of this.runAsyncImpl(context)) {
              yield event;
            }

            if (context.endInvocation || parentContext.abortSignal?.aborted) {
              return;
            }

            const afterAgentCallbackEvent =
              await this.handleAfterAgentCallback(context);
            if (afterAgentCallbackEvent) {
              yield afterAgentCallbackEvent;
            }
          } catch (error: unknown) {
            await this.handleAgentErrorCallback(context, error);
            throw error;
          }
        },
      );
    } finally {
      span.end();
    }
  }

  /**
   * Runs this agent as a workflow node.
   *
   * The node runner calls this; it delegates to {@link runAsync}, so an agent
   * behaves identically whether it is run directly or as a node. Mirrors
   * adk-python `BaseAgent._run_impl`.
   *
   * The invocation context comes from {@link NodeContext.getInvocationContext}
   * rather than the raw field, so the agent runs against whatever view of the
   * session the workflow wants it to see.
   *
   * The node path is not stamped here, unlike adk-python's `_run_impl`: the
   * TypeScript node runner always stamps the true one, so repeating it would be
   * dead code. The author is recorded on the context (`ctx.eventAuthor`) so the
   * runner attributes a later event this agent leaves unattributed to the agent
   * rather than to the node — adk-python does the same at
   * `agents/base_agent.py` `_run_impl`.
   *
   * `nodeInput` is intentionally unused: an agent's input is its conversation,
   * which the workflow supplies through the session. A node that needs to read
   * its input — an `LlmAgent` injecting it into the prompt, say — does so in
   * its own wrapper.
   */
  protected async *runImpl(
    ctx: NodeContext,
    _nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    for await (const event of this.runAsync(ctx.getInvocationContext())) {
      if (event.author) {
        ctx.eventAuthor = event.author;
      }
      yield event;
    }
  }

  /**
   * Entry method to run an agent via video/audio-based conversation.
   *
   * @param parentContext The invocation context of the parent agent.
   * @yields The events generated by the agent.
   * @returns An AsyncGenerator that yields the events generated by the agent.
   */
  async *runLive(
    parentContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const span = tracer.startSpan(`invoke_agent ${this.name}`);
    const ctx = trace.setSpan(context.active(), span);
    try {
      yield* runAsyncGeneratorWithOtelContext<BaseAgent, Event>(
        ctx,
        this,
        async function* () {
          // Built outside the try, as in runAsync.
          const context = this.createInvocationContext(parentContext);

          try {
            const beforeAgentCallbackEvent =
              await this.handleBeforeAgentCallback(context);
            if (beforeAgentCallbackEvent) {
              yield beforeAgentCallbackEvent;
            }

            if (context.endInvocation || parentContext.abortSignal?.aborted) {
              return;
            }

            for await (const event of this.runLiveImpl(context)) {
              yield event;
            }

            if (context.endInvocation || parentContext.abortSignal?.aborted) {
              return;
            }

            const afterAgentCallbackEvent =
              await this.handleAfterAgentCallback(context);
            if (afterAgentCallbackEvent) {
              yield afterAgentCallbackEvent;
            }
          } catch (error: unknown) {
            await this.handleAgentErrorCallback(context, error);
            throw error;
          }
        },
      );
    } finally {
      span.end();
    }
  }

  /**
   * Core logic to run this agent via text-based conversation.
   *
   * @param context The invocation context of the agent.
   * @yields The events generated by the agent.
   * @returns An AsyncGenerator that yields the events generated by the agent.
   */
  protected abstract runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void>;

  /**
   * Core logic to run this agent via video/audio-based conversation.
   *
   * @param context The invocation context of the agent.
   * @yields The events generated by the agent.
   * @returns An AsyncGenerator that yields the events generated by the agent.
   */
  protected abstract runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void>;

  /**
   * Finds the agent with the given name in this agent and its descendants.
   *
   * @param name The name of the agent to find.
   * @return The agent with the given name, or undefined if not found.
   */
  findAgent(name: string): BaseAgent | undefined {
    if (this.name === name) {
      return this;
    }

    return this.findSubAgent(name);
  }

  /**
   * Finds the agent with the given name in this agent's descendants.
   *
   * @param name The name of the agent to find.
   * @return The agent with the given name, or undefined if not found.
   */
  findSubAgent(name: string): BaseAgent | undefined {
    for (const subAgent of this.subAgents) {
      const result = subAgent.findAgent(name);
      if (result) {
        return result;
      }
    }

    return undefined;
  }

  /**
   * Loads this agent's resumption checkpoint from the invocation context.
   *
   * `parse` narrows the persisted record into the agent's own state type. It
   * is the analogue of adk-python validating the snapshot against a pydantic
   * model, so it should throw on a snapshot it cannot read rather than guess.
   *
   * @param ctx The invocation context.
   * @param parse Converts the persisted record into the agent's state type.
   * @return The parsed state, or undefined when this agent has no checkpoint.
   */
  protected loadAgentState<T>(
    ctx: InvocationContext,
    parse: (raw: BaseAgentState) => T,
  ): T | undefined {
    const raw = ctx.agentStates[this.name];
    if (raw === undefined) {
      return undefined;
    }
    return parse(raw);
  }

  /**
   * Creates an invocation context for this agent.
   *
   * @param parentContext The invocation context of the parent agent.
   * @return The invocation context for this agent.
   */
  protected createInvocationContext(
    parentContext: InvocationContext,
  ): InvocationContext {
    return new InvocationContext({
      ...parentContext,
      agent: this,
    });
  }

  /**
   * Builds the checkpoint event that carries this agent's state recorded on
   * `ctx`. The event has no content: it exists so that a resumed invocation can
   * read the agent's progress back out of the session.
   *
   * @param ctx The invocation context holding the state.
   * @return The checkpoint event to yield.
   */
  protected createAgentStateEvent(ctx: InvocationContext): Event {
    const actions: Partial<EventActions> = {};
    const agentState = ctx.agentStates[this.name];
    if (agentState !== undefined) {
      actions.agentState = agentState;
    }
    if (ctx.endOfAgents[this.name]) {
      actions.endOfAgent = true;
    }
    return createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      actions,
    });
  }

  /**
   * Runs the registered plugins' before-agent callbacks, then this agent's own.
   *
   * A plugin takes precedence: content from a plugin skips this agent's own
   * callbacks entirely, as in adk-python. With neither a plugin nor an own
   * callback there is nothing to observe the callback context, so it is not
   * built.
   *
   * @param invocationContext The invocation context of the agent.
   * @return The event to return to the user, or undefined if no event is
   *     generated.
   */
  protected async handleBeforeAgentCallback(
    invocationContext: InvocationContext,
  ): Promise<Event | undefined> {
    if (
      !invocationContext.pluginManager.hasPlugins &&
      this.beforeAgentCallback.length === 0
    ) {
      return undefined;
    }

    const callbackContext = new Context({invocationContext});

    // Plugins run first and take precedence: content from a plugin skips this
    // agent's own callbacks and its body, matching adk-python.
    const pluginContent =
      await invocationContext.pluginManager.runBeforeAgentCallback({
        agent: this,
        callbackContext,
      });
    if (pluginContent) {
      invocationContext.endInvocation = true;

      return createEvent({
        invocationId: invocationContext.invocationId,
        author: this.name,
        branch: invocationContext.branch,
        content: pluginContent,
        actions: callbackContext.eventActions,
      });
    }

    for (const callback of this.beforeAgentCallback) {
      const content = await callback(callbackContext);

      if (invocationContext.abortSignal?.aborted) {
        return;
      }

      if (content) {
        invocationContext.endInvocation = true;

        return createEvent({
          invocationId: invocationContext.invocationId,
          author: this.name,
          branch: invocationContext.branch,
          content,
          actions: callbackContext.eventActions,
        });
      }
    }

    if (callbackContext.state.hasDelta()) {
      return createEvent({
        invocationId: invocationContext.invocationId,
        author: this.name,
        branch: invocationContext.branch,
        actions: callbackContext.eventActions,
      });
    }

    return undefined;
  }

  /**
   * Runs the registered plugins' after-agent callbacks, then this agent's own.
   *
   * Same precedence and same fast path as {@link handleBeforeAgentCallback},
   * except that content here does not end the invocation.
   *
   * @param invocationContext The invocation context of the agent.
   * @return The event to return to the user, or undefined if no event is
   *     generated.
   */
  protected async handleAfterAgentCallback(
    invocationContext: InvocationContext,
  ): Promise<Event | undefined> {
    if (
      !invocationContext.pluginManager.hasPlugins &&
      this.afterAgentCallback.length === 0
    ) {
      return undefined;
    }

    const callbackContext = new Context({invocationContext});

    // Plugins run first and take precedence, as in handleBeforeAgentCallback.
    const pluginContent =
      await invocationContext.pluginManager.runAfterAgentCallback({
        agent: this,
        callbackContext,
      });
    if (pluginContent) {
      return createEvent({
        invocationId: invocationContext.invocationId,
        author: this.name,
        branch: invocationContext.branch,
        content: pluginContent,
        actions: callbackContext.eventActions,
      });
    }

    for (const callback of this.afterAgentCallback) {
      const content = await callback(callbackContext);

      if (invocationContext.abortSignal?.aborted) {
        return;
      }

      if (content) {
        return createEvent({
          invocationId: invocationContext.invocationId,
          author: this.name,
          branch: invocationContext.branch,
          content,
          actions: callbackContext.eventActions,
        });
      }
    }

    if (callbackContext.state.hasDelta()) {
      return createEvent({
        invocationId: invocationContext.invocationId,
        author: this.name,
        branch: invocationContext.branch,
        actions: callbackContext.eventActions,
      });
    }

    return undefined;
  }

  /**
   * Notifies every plugin that an error escaped this agent's execution.
   *
   * Notification only, and best-effort: the caller always re-throws the
   * original error, and a plugin that fails here is logged so it can never
   * mask that error. Mirrors adk-python `_handle_agent_error_callback`.
   *
   * @param invocationContext The invocation context of the agent.
   * @param error The error that escaped agent execution.
   */
  protected async handleAgentErrorCallback(
    invocationContext: InvocationContext,
    error: unknown,
  ): Promise<void> {
    // A cancelled invocation is not an agent error. Python gets this for free:
    // `asyncio.CancelledError` is a BaseException, so `except Exception` never
    // sees it.
    if (invocationContext.abortSignal?.aborted) {
      return;
    }

    try {
      await invocationContext.pluginManager.runOnAgentErrorCallback({
        agent: this,
        callbackContext: new Context({invocationContext}),
        error: error instanceof Error ? error : new Error(formatError(error)),
      });
    } catch (callbackError: unknown) {
      logger.error(
        'onAgentErrorCallback raised; suppressing so the original agent ' +
          `error propagates: ${formatError(callbackError)}`,
      );
    }
  }

  private setParentAgentForSubAgents(): void {
    for (const subAgent of this.subAgents) {
      if (subAgent.parentAgent) {
        throw new Error(
          `Agent "${
            subAgent.name
          }" already has a parent agent, current parent: "${
            subAgent.parentAgent.name
          }", trying to add: "${this.name}"`,
        );
      }

      subAgent.parentAgent = this;
    }
  }
}

/**
 * Validates the agent name.
 *
 * @param name The name of the agent.
 * @return The validated agent name.
 */
function validateAgentName(name: string): string {
  validateIdentifierName('Agent', name);

  if (name === 'user') {
    throw new Error(
      `Agent name cannot be 'user'. 'user' is reserved for end-user's input.`,
    );
  }

  return name;
}

/**
 * Warns when two sub-agents share a name.
 *
 * A duplicate name makes {@link BaseAgent.findSubAgent} return whichever agent
 * comes first, which is almost never what the author meant. Mirrors adk-python
 * `validate_sub_agents_unique_names`: it warns and lets construction proceed,
 * so an existing tree keeps working.
 *
 * @param subAgents The sub-agents to check.
 */
function warnOnDuplicateSubAgentNames(subAgents: readonly BaseAgent[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const subAgent of subAgents) {
    if (seen.has(subAgent.name)) {
      duplicates.add(subAgent.name);
    } else {
      seen.add(subAgent.name);
    }
  }

  if (duplicates.size === 0) {
    return;
  }

  const names = [...duplicates]
    .sort()
    .map((name) => `\`${name}\``)
    .join(', ');
  logger.warn(
    `Found duplicate sub-agent names: ${names}. All sub-agents must have unique names.`,
  );
}

/**
 * Gets the root agent of the given agent.
 *
 * @param rootAgent The root agent to get the root agent of.
 * @return The root agent.
 */
function getRootAgent(rootAgent: BaseAgent): BaseAgent {
  while (rootAgent.parentAgent) {
    rootAgent = rootAgent.parentAgent;
  }

  return rootAgent;
}

/**
 * Gets the canonical callback from the given callback.
 *
 * @param callbacks The callback or list of callbacks to get the canonical
 *     callback from.
 * @return The canonical callback.
 */
export function getCannonicalCallback<T>(callbacks?: T | T[]): T[] {
  if (!callbacks) {
    return [];
  }

  return Array.isArray(callbacks) ? callbacks : [callbacks];
}
