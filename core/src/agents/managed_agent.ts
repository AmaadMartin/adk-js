/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentConfig,
  GoogleGenAI,
  Interactions,
  Tool,
} from '@google/genai';

import {createEvent, Event} from '../events/event.js';
import {
  buildInteractionsRequestLog,
  buildMcpServerParam,
  convertContentToSteps,
  convertToolsConfigToInteractionsFormat,
  createInteractions,
  InteractionsClient,
} from '../models/interactions_utils.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {tracer} from '../telemetry/tracing.js';
import {BaseTool, isBaseTool, isInModelTool} from '../tools/base_tool.js';
import {
  isRemoteMcpServer,
  RemoteMcpServer,
} from '../tools/remote_mcp_server.js';
import {
  getTrackingHeaders,
  mergeTrackingHeaders,
} from '../utils/client_labels.js';
import {coerceToUserContent} from '../utils/content_utils.js';
import {isEnterpriseModeEnabled} from '../utils/env_aware_utils.js';
import {formatError, getApiErrorDetails} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import type {NodeContext} from '../workflow/node_context.js';
import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {Context} from './context.js';
import {injectSessionState} from './instructions.js';
import {InvocationContext} from './invocation_context.js';
import type {InstructionProvider} from './llm_agent.js';
import {findPreviousInteractionState} from './processors/interactions_request_processor.js';
import {ReadonlyContext} from './readonly_context.js';
import {StreamingMode} from './run_config.js';

/**
 * The Managed Agents API is served only from the `global` location; a regional
 * endpoint rejects the call. Pinning it here keeps the agent working whatever
 * `GOOGLE_CLOUD_LOCATION` the caller's environment sets. The project is still
 * resolved from the environment and ADC as usual.
 */
const MANAGED_AGENT_LOCATION = 'global';

/** Names this ADK surface in the outbound tracking headers. */
const MANAGED_AGENT_FRAMEWORK_LABEL = 'managed_agent';

/** Error code used when a failure carries no backend status. */
const UNKNOWN_ERROR_CODE = 'UNKNOWN_ERROR';

/** The span opened around one interaction call. */
const INTERACTION_SPAN_NAME = 'managed_agent_interaction';

/** Prefix shared by every rejection of a tool the client would have to run. */
const CLIENT_EXECUTED_PREFIX =
  'client-executed tools are not supported by ManagedAgent';

const MANAGED_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.managedAgent');

/**
 * A sandbox environment spec, or the id of an existing environment to reuse
 * across turns.
 */
export type ManagedAgentEnvironment = Interactions.Environment | string;

/** Runtime configuration forwarded to `interactions.create`. */
export type ManagedAgentRuntimeConfig =
  | Interactions.DynamicAgentConfig
  | Interactions.DeepResearchAgentConfig;

/**
 * The part of a `GoogleGenAI` client a {@link ManagedAgent} uses.
 *
 * Declared structurally, for the reason given on {@link InteractionsClient}: a
 * nominal dependency breaks when a runtime resolves `@google/genai` twice. A
 * real `GoogleGenAI` satisfies this.
 */
export interface ManagedAgentClient extends InteractionsClient {
  /** Whether the client targets the enterprise backend. */
  readonly vertexai: boolean;
}

/** A server-side tool a {@link ManagedAgent} accepts. */
export type ManagedAgentTool = Tool | BaseTool | RemoteMcpServer;

/** The configuration of a {@link ManagedAgent}. */
export interface ManagedAgentConfig extends BaseAgentConfig {
  /**
   * The Managed Agent id, e.g. `antigravity-preview-05-2026` or `agents/ID`.
   */
  agentId: string;

  /** A sandbox environment spec, or an existing environment id to reuse. */
  environment?: ManagedAgentEnvironment;

  /** Runtime configuration passed to `interactions.create`. */
  agentConfig?: ManagedAgentRuntimeConfig;

  /**
   * The system instruction sent to the Managed Agent. Empty by default, in
   * which case no system instruction is sent.
   *
   * A plain string may embed `{var}`, `{artifact.name}` or `{var?}`
   * placeholders, which are resolved from session state and artifacts at
   * request time. An {@link InstructionProvider} manages its own state, so its
   * output is sent verbatim.
   */
  instruction?: string | InstructionProvider;

  /** Server-side tools. Empty by default. */
  tools?: ManagedAgentTool[];

  /**
   * A client to call instead of the lazily created one. It is used as given:
   * ADK attaches no headers and no `httpOptions` to it.
   */
  apiClient?: ManagedAgentClient;
}

/**
 * Whether `value` is a {@link ManagedAgent}.
 *
 * @param value The value to test.
 * @return True when `value` is a Managed Agent.
 */
export function isManagedAgent(value: unknown): value is ManagedAgent {
  return (
    typeof value === 'object' &&
    value !== null &&
    MANAGED_AGENT_SIGNATURE_SYMBOL in value &&
    value[MANAGED_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * An agent backed by the Managed Agents API.
 *
 * It calls `interactions.create` straight from its run loop instead of going
 * through an LLM flow, so the backend owns the sandbox, the server-side tools
 * and the conversation state. Multi-turn conversations chain server-side: the
 * agent recovers the previous interaction and environment ids from the session
 * and sends them with the next turn.
 *
 * Only server-side tools are supported — ADK built-in tools, raw
 * `types.Tool` configs the interactions converter understands, and
 * {@link RemoteMcpServer} specs. A tool the client would have to execute is
 * rejected before the network call.
 *
 * Only streaming is supported. Every interaction is created with
 * `background: true`, which the Managed Agents workflow requires, and consumed
 * over the open stream. Partial responses reach the caller only in
 * {@link StreamingMode.SSE}.
 *
 * Mirrors `ManagedAgent` in google/adk-python `agents/_managed_agent.py`.
 *
 * @example
 * ```ts
 * const agent = new ManagedAgent({
 *   name: 'managed_search_agent',
 *   agentId: 'antigravity-preview-05-2026',
 *   environment: {type: 'remote'},
 *   tools: [new GoogleSearchTool()],
 * });
 * ```
 */
export class ManagedAgent extends BaseAgent<ManagedAgentConfig> {
  readonly [MANAGED_AGENT_SIGNATURE_SYMBOL] = true;

  /** The Managed Agent id this agent drives. */
  readonly agentId: string;

  /** The sandbox environment spec, or an existing environment id. */
  readonly environment?: ManagedAgentEnvironment;

  /** Runtime configuration passed to `interactions.create`. */
  readonly agentConfig?: ManagedAgentRuntimeConfig;

  /** The system instruction, or a provider that builds it per turn. */
  readonly instruction: string | InstructionProvider;

  /** The server-side tools this agent offers the backend. */
  readonly tools: ManagedAgentTool[];

  private cachedApiClient?: ManagedAgentClient;

  constructor(config: ManagedAgentConfig) {
    super(config);
    this.agentId = config.agentId;
    this.environment = config.environment;
    this.agentConfig = config.agentConfig;
    this.instruction = config.instruction ?? '';
    this.tools = config.tools ?? [];
    if (config.apiClient) {
      validateClientLocation(config.apiClient);
      this.cachedApiClient = config.apiClient;
    }
  }

  /**
   * The genai client, created on first use when none was injected.
   *
   * The backend follows `GOOGLE_GENAI_USE_ENTERPRISE` (or the legacy
   * `GOOGLE_GENAI_USE_VERTEXAI`), defaulting to the Gemini Developer API. The
   * enterprise backend is pinned to `global`; the Developer API takes no
   * location, where the concept is meaningless.
   */
  get apiClient(): ManagedAgentClient {
    this.cachedApiClient ??= isEnterpriseModeEnabled()
      ? new GoogleGenAI({
          enterprise: true,
          location: MANAGED_AGENT_LOCATION,
          httpOptions: {headers: getTrackingHeaders()},
        })
      : new GoogleGenAI({
          enterprise: false,
          httpOptions: {headers: getTrackingHeaders()},
        });
    return this.cachedApiClient;
  }

  /**
   * Resolves {@link instruction} for the current context.
   *
   * Matches `LlmAgent.canonicalInstruction`, including its polarity: a plain
   * string requires state injection, and an {@link InstructionProvider} does
   * not, because it manages its own state.
   *
   * @param context The context used to resolve a provider.
   * @return The instruction and whether it still needs state injection.
   */
  async canonicalInstruction(
    context: ReadonlyContext,
  ): Promise<{instruction: string; requireStateInjection: boolean}> {
    if (typeof this.instruction === 'string') {
      return {instruction: this.instruction, requireStateInjection: true};
    }
    return {
      instruction: await this.instruction(context),
      requireStateInjection: false,
    };
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // State recovery and tool resolution run outside the try so a configuration
    // error is thrown rather than turned into an error event.
    const previous = findPreviousInteractionState(
      context.session.events,
      this.name,
      context.branch,
    );
    const environment = previous.environmentId ?? this.environment;
    const inputSteps = context.userContent
      ? convertContentToSteps(context.userContent)
      : [];
    const tools = await this.resolveBackendTools(context);
    const systemInstruction = await this.resolveSystemInstruction(context);

    const createParams: Interactions.CreateAgentInteractionParamsStreaming = {
      agent: this.agentId,
      input: inputSteps,
      // The Managed Agents workflow requires background execution; the result
      // arrives over the stream this call opens.
      background: true,
    };
    if (tools.length > 0) {
      createParams.tools = tools;
    }
    if (environment !== undefined) {
      createParams.environment = environment;
    }
    if (this.agentConfig !== undefined) {
      createParams.agent_config = this.agentConfig;
    }
    if (previous.interactionId) {
      createParams.previous_interaction_id = previous.interactionId;
    }
    if (systemInstruction) {
      createParams.system_instruction = systemInstruction;
    }

    const extraHeaders = mergeTrackingHeaders(
      context.runConfig?.httpOptions?.headers,
      MANAGED_AGENT_FRAMEWORK_LABEL,
    );

    logger.debug(
      buildInteractionsRequestLog({
        model: this.agentId,
        inputSteps,
        systemInstruction,
        tools,
        previousInteractionId: previous.interactionId,
        stream: true,
      }),
    );

    const sse = context.runConfig?.streamingMode === StreamingMode.SSE;
    const span = tracer.startSpan(INTERACTION_SPAN_NAME);
    try {
      for await (const llmResponse of createInteractions(this.apiClient, {
        createParams,
        extraHeaders,
      })) {
        // The backend always streams. Outside SSE mode only the aggregated
        // final response and any error reach the caller, matching what an
        // LlmAgent surfaces.
        if (sse || !llmResponse.partial) {
          yield this.responseToEvent(context, llmResponse);
        }
      }
    } catch (error: unknown) {
      logger.error('ManagedAgent interaction failed', error);
      yield this.toErrorEvent(context, error);
    } finally {
      span.end();
    }
  }

  /**
   * Runs the agent as a workflow node, threading the node input into the user
   * content so a single-turn tool call reaches the backend as this turn's
   * input.
   *
   * Unlike adk-python's `_run_impl`, nothing is stamped onto the events here:
   * the node runner already owns the author and the node path, as
   * {@link BaseAgent.runImpl} explains.
   */
  protected override async *runImpl(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    const parentContext = ctx.getInvocationContext();
    yield* this.runAsync(
      nodeInput === undefined || nodeInput === null
        ? parentContext
        : parentContext.clone({userContent: coerceToUserContent(nodeInput)}),
    );
  }

  /**
   * Declared as a plain method rather than a generator: it never emits, and a
   * generator body with no `yield` would need a lint suppression to say so.
   */
  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error(
      'ManagedAgent does not support live (bidirectional) runs; use runAsync.',
    );
  }

  /**
   * Resolves {@link tools} into interaction tool params, rejecting anything the
   * client would have to execute.
   */
  private async resolveBackendTools(
    context: InvocationContext,
  ): Promise<Interactions.Tool[]> {
    // Built-in tools resolve in managed-agent mode: the request carries no
    // model and the `isManagedAgent` flag instead, so a tool that gates on a
    // Gemini model still configures itself. Nothing here is sent as a request;
    // the real call names `agent` instead.
    const config: GenerateContentConfig = {};
    const llmRequest: LlmRequest = {
      contents: [],
      config,
      liveConnectConfig: {},
      toolsDict: {},
      isManagedAgent: true,
    };
    const toolContext = new Context({invocationContext: context});
    const mcpParams: Interactions.Tool[] = [];

    for (const tool of this.tools) {
      if (isBaseTool(tool)) {
        await resolveBaseTool(tool, toolContext, llmRequest);
      } else if (isRemoteMcpServer(tool)) {
        mcpParams.push(
          buildMcpServerParam(tool, await resolveMcpHeaders(tool, context)),
        );
      } else {
        rejectUnsupportedRawTool(tool);
        config.tools = [...(config.tools ?? []), tool];
      }
    }

    return [...convertToolsConfigToInteractionsFormat(config), ...mcpParams];
  }

  /** Resolves the system instruction, injecting session state when required. */
  private async resolveSystemInstruction(
    context: InvocationContext,
  ): Promise<string> {
    const readonlyContext = new ReadonlyContext(context);
    const {instruction, requireStateInjection} =
      await this.canonicalInstruction(readonlyContext);
    return requireStateInjection
      ? injectSessionState(instruction, readonlyContext)
      : instruction;
  }

  /** Maps a streamed response to an event authored by this agent. */
  private responseToEvent(
    context: InvocationContext,
    llmResponse: LlmResponse,
  ): Event {
    return createEvent({
      ...llmResponse,
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
    });
  }

  /**
   * Builds the terminal error event for a failed call or stream.
   *
   * `turnComplete` is always set, so the Runner sees a terminal event even
   * when the backend never sent one.
   */
  private toErrorEvent(context: InvocationContext, error: unknown): Event {
    const details = getApiErrorDetails(error);
    return createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      errorCode: details?.status ?? UNKNOWN_ERROR_CODE,
      errorMessage: details?.message ?? formatError(error),
      turnComplete: true,
    });
  }
}

/** The genai-internal shape that carries a client's resolved location. */
interface LocationCarrier {
  apiClient: {getLocation(): unknown};
}

/** Whether `client` exposes the genai-internal location accessor. */
function hasLocationAccessor(client: unknown): client is LocationCarrier {
  const apiClient = (client as Partial<LocationCarrier> | null)?.apiClient;
  return typeof apiClient?.getLocation === 'function';
}

/**
 * Returns the client's resolved location, or undefined when it has none.
 *
 * `@google/genai` 2.9.0 publishes no accessor for a client's location: it sits
 * behind the protected `apiClient.getLocation()`. This is the one private
 * dependency here — the backend comes from the public `vertexai` property. The
 * value is read structurally, so a client that does not expose it yields
 * undefined rather than throwing.
 */
export function resolveClientLocation(
  client: ManagedAgentClient,
): string | undefined {
  if (!hasLocationAccessor(client)) {
    return undefined;
  }
  const location = client.apiClient.getLocation();
  return typeof location === 'string' ? location : undefined;
}

/**
 * Rejects an injected enterprise client that does not target `global`.
 *
 * The check applies only to the enterprise backend. The Gemini Developer API
 * has no location concept, yet genai still stamps `GOOGLE_CLOUD_LOCATION` onto
 * every client, so a regional Developer API client must be accepted. ADK never
 * overrides a caller-supplied client, so a client that cannot work is rejected
 * loudly instead.
 */
function validateClientLocation(client: ManagedAgentClient): void {
  if (!client.vertexai) {
    return;
  }
  const location = resolveClientLocation(client);
  if (location !== undefined && location !== MANAGED_AGENT_LOCATION) {
    throw new Error(
      `ManagedAgent requires an enterprise client configured for the ` +
        `'${MANAGED_AGENT_LOCATION}' location; got location='${location}'. ` +
        `The Managed Agents API is only served from ` +
        `'${MANAGED_AGENT_LOCATION}'.`,
    );
  }
}

/**
 * Lets a built-in tool configure the request, and rejects it when it turns out
 * to be client-executed.
 *
 * A tool the model runs itself registers its name so a stray function call
 * naming it stays routable, so the registration alone proves nothing. A tool
 * that registers while not being an in-model tool declared a function the
 * client would have to run, which the Managed Agents backend cannot do.
 */
async function resolveBaseTool(
  tool: BaseTool,
  toolContext: Context,
  llmRequest: LlmRequest,
): Promise<void> {
  const before = Object.keys(llmRequest.toolsDict).length;
  await tool.processLlmRequest({toolContext, llmRequest});
  if (
    Object.keys(llmRequest.toolsDict).length > before &&
    !isInModelTool(tool)
  ) {
    throw new Error(`${CLIENT_EXECUTED_PREFIX}: ${tool.name}`);
  }
}

/** Throws when a raw tool config is not one the backend can run server-side. */
function rejectUnsupportedRawTool(tool: Tool): void {
  if (tool.mcpServers) {
    throw new Error(
      'Raw mcpServers tool configs are not supported by ManagedAgent; ' +
        'declare a RemoteMcpServer instead.',
    );
  }
  if (tool.functionDeclarations) {
    throw new Error(`${CLIENT_EXECUTED_PREFIX}: ${JSON.stringify(tool)}`);
  }
  if (
    !tool.googleSearch &&
    !tool.codeExecution &&
    !tool.urlContext &&
    !tool.computerUse
  ) {
    throw new Error(
      'Unsupported raw Tool for ManagedAgent; the supported server-side ' +
        'fields are googleSearch, codeExecution, urlContext and computerUse: ' +
        JSON.stringify(tool),
    );
  }
}

/**
 * Merges a server's static headers with whatever its provider mints for this
 * turn. The provider wins on a key conflict, and the spec's own headers object
 * is never mutated.
 */
async function resolveMcpHeaders(
  server: RemoteMcpServer,
  context: InvocationContext,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {...server.headers};
  if (server.headerProvider) {
    Object.assign(
      resolved,
      await server.headerProvider(new ReadonlyContext(context)),
    );
  }
  return resolved;
}
