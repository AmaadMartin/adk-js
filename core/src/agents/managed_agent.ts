/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, GoogleGenAI, Interactions, Tool} from '@google/genai';
import {context, trace} from '@opentelemetry/api';

import {createEvent, Event} from '../events/event.js';
import {
  buildMcpServerParam,
  convertContentToSteps,
  convertToolsConfigToInteractionsFormat,
  createInteractions,
} from '../models/interactions_utils.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {
  runAsyncGeneratorWithOtelContext,
  tracer,
} from '../telemetry/tracing.js';
import {isBaseTool, isInModelTool} from '../tools/base_tool.js';
import {
  isRemoteMcpServer,
  RemoteMcpServer,
} from '../tools/remote_mcp_server.js';
import {getTrackingHeaders} from '../utils/client_labels.js';
import {isContent, toUserContent} from '../utils/content_utils.js';
import {isEnterpriseModeEnabled} from '../utils/env_aware_utils.js';
import {asApiFailure, formatError} from '../utils/error_utils.js';
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
 * The Managed Agents API is only served from the `global` location; a regional
 * endpoint rejects these calls. Pinning it here keeps the agent working
 * whatever `GOOGLE_CLOUD_LOCATION` the caller's environment holds. The project
 * is still resolved from the environment as usual.
 */
const MANAGED_AGENT_LOCATION = 'global';

/** Reported on a failed turn whose error carries no backend status. */
const UNKNOWN_ERROR_CODE = 'UNKNOWN_ERROR';

/** The raw `Tool` fields the Managed Agents API runs server-side. */
const SUPPORTED_RAW_TOOL_FIELDS = [
  'googleSearch',
  'codeExecution',
  'urlContext',
  'computerUse',
] as const;

/**
 * Reaches the location a genai client resolved.
 *
 * `@google/genai` 2.9.0 publishes no accessor for it. `GoogleGenAI.apiClient`
 * is TypeScript-`protected` and its `getLocation()` is public, so a subclass is
 * what reads it without an unchecked cast.
 */
class ClientLocationReader extends GoogleGenAI {
  static locationOf(client: ClientLocationReader): string | undefined {
    return client.apiClient?.getLocation();
  }
}

/**
 * Returns the client's resolved location, or `undefined` when it has none.
 *
 * A client that carries no `apiClient` yields `undefined`, and callers treat an
 * unresolvable location as acceptable.
 */
function resolveClientLocation(client: GoogleGenAI): string | undefined {
  return ClientLocationReader.locationOf(client);
}

/**
 * Rejects an injected enterprise client that does not target `global`.
 *
 * The check applies to enterprise clients only. The Gemini Developer API has no
 * location concept, yet genai still stamps `GOOGLE_CLOUD_LOCATION` onto every
 * client, so a Developer-API client must not be rejected for it. A
 * caller-supplied client is never rewritten, but a regional enterprise client
 * cannot work, so it is rejected loudly.
 *
 * @throws Error if the client is enterprise and resolves to another location.
 */
function validateClientLocation(client: GoogleGenAI): void {
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

/** The message every client-executed tool is rejected with. */
function clientExecutedMessage(tool: string): string {
  return `client-executed tools are not yet supported by ManagedAgent: ${tool}`;
}

/** Whether a raw `Tool` sets at least one field the backend runs itself. */
function hasSupportedRawToolField(tool: Tool): boolean {
  return SUPPORTED_RAW_TOOL_FIELDS.some((field) => tool[field]);
}

/**
 * Resolves the headers one remote MCP server is called with.
 *
 * The spec's static headers are merged with the `headerProvider` output, which
 * wins on a key conflict. The spec's own `headers` object is never mutated.
 */
async function resolveMcpHeaders(
  server: RemoteMcpServer,
  ctx: InvocationContext,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {...server.headers};
  if (server.headerProvider) {
    Object.assign(
      resolved,
      await server.headerProvider(new ReadonlyContext(ctx)),
    );
  }
  return resolved;
}

/**
 * Converts a node's input into the agent's user content.
 *
 * A `Content` passes through and a string becomes one text part; any other
 * value is serialized, matching what an `LlmAgent` node does with its input.
 */
function nodeInputToUserContent(nodeInput: unknown): Content {
  return toUserContent(
    isContent(nodeInput) || typeof nodeInput === 'string'
      ? nodeInput
      : JSON.stringify(nodeInput),
  );
}

/** The configuration options for creating a managed agent. */
export interface ManagedAgentConfig extends BaseAgentConfig {
  /** The Managed Agent id, for example `agents/my-agent`. */
  agentId: string;

  /**
   * A sandbox environment spec, or an existing environment id to reuse across
   * turns.
   */
  environment?: Interactions.Environment | string;

  /** Runtime configuration passed to the interactions call. */
  agentConfig?:
    | Interactions.DynamicAgentConfig
    | Interactions.DeepResearchAgentConfig;

  /**
   * The system instruction sent to the managed agent.
   *
   * A plain string may embed `{var}`, `{artifact.name}` or `{var?}`
   * placeholders, which are resolved from session state and artifacts at
   * request time. An `InstructionProvider` is called with a `ReadonlyContext`
   * and bypasses that injection, because it manages state itself. Empty by
   * default, in which case no system instruction is sent.
   */
  instruction?: string | InstructionProvider;

  /**
   * Server-side tools: ADK built-in tools, raw genai `Tool` configs, or
   * {@link RemoteMcpServer} specs. Client-executed tools are rejected.
   */
  tools?: Array<Tool | RemoteMcpServer>;

  /**
   * Composition mode.
   *
   * Only `single_turn` is supported: the agent runs as an inline single-turn
   * tool of a parent `LlmAgent`, keeping its own events in the shared session.
   * Unset leaves the agent usable as a transfer target.
   */
  mode?: 'single_turn';

  /**
   * A genai client to use instead of the lazily built one. It is returned by
   * identity and never rewritten, so it must already target the `global`
   * location when it is an enterprise client.
   */
  apiClient?: GoogleGenAI;
}

/**
 * A unique symbol to identify ADK managed agent classes.
 * Defined once and shared by all ManagedAgent instances.
 */
const MANAGED_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.managedAgent');

/**
 * Type guard to check if an object is an instance of ManagedAgent.
 * @param obj The object to check.
 * @returns True if the object is a ManagedAgent, false otherwise.
 */
export function isManagedAgentInstance(obj: unknown): obj is ManagedAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    MANAGED_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[MANAGED_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * An agent backed by the Managed Agents API.
 *
 * The agent calls the interactions endpoint from its own execution loop rather
 * than through an `Llm`. Only server-side tools work: ADK built-in tools, the
 * raw genai `Tool` configs the interactions converter understands, and
 * {@link RemoteMcpServer} specs the backend connects to. Client-executed tools
 * and raw `mcpServers` configs are rejected.
 *
 * The agent supports streaming interactions only. Every interaction is created
 * with `background: true`, which the Managed Agents workflow requires, and its
 * result is consumed over the streaming connection.
 *
 * Ports `ManagedAgent` in google/adk-python `agents/_managed_agent.py`.
 */
export class ManagedAgent extends BaseAgent<ManagedAgentConfig> {
  /** A unique symbol to identify ADK managed agent class. */
  readonly [MANAGED_AGENT_SIGNATURE_SYMBOL] = true;

  readonly agentId: string;
  readonly environment?: Interactions.Environment | string;
  readonly agentConfig?:
    | Interactions.DynamicAgentConfig
    | Interactions.DeepResearchAgentConfig;
  readonly instruction: string | InstructionProvider;
  readonly tools: Array<Tool | RemoteMcpServer>;
  readonly mode?: 'single_turn';

  private lazyApiClient?: GoogleGenAI;

  constructor(config: ManagedAgentConfig) {
    super(config);
    if (!config.agentId) {
      throw new Error('ManagedAgent requires a non-empty agentId.');
    }
    // The union type covers TypeScript callers; the check covers JavaScript
    // ones, for whom an unsupported mode would otherwise run as no mode.
    if (config.mode !== undefined && config.mode !== 'single_turn') {
      throw new Error(
        `ManagedAgent supports only mode 'single_turn'; got ` +
          `'${String(config.mode)}'.`,
      );
    }
    this.agentId = config.agentId;
    this.environment = config.environment;
    this.agentConfig = config.agentConfig;
    this.instruction = config.instruction ?? '';
    this.tools = config.tools ?? [];
    this.mode = config.mode;
    if (config.apiClient) {
      validateClientLocation(config.apiClient);
      this.lazyApiClient = config.apiClient;
    }
  }

  /**
   * The genai client, built on first use when none was injected.
   *
   * The backend follows the environment, matching genai semantics; with no
   * environment set it is the Gemini Developer API. The enterprise backend is
   * pinned to `global`, and the Developer API takes no location because the
   * concept is meaningless there.
   */
  get apiClient(): GoogleGenAI {
    if (!this.lazyApiClient) {
      const httpOptions = {headers: getTrackingHeaders()};
      this.lazyApiClient = isEnterpriseModeEnabled()
        ? new GoogleGenAI({
            enterprise: true,
            location: MANAGED_AGENT_LOCATION,
            httpOptions,
          })
        : new GoogleGenAI({enterprise: false, httpOptions});
    }
    return this.lazyApiClient;
  }

  /**
   * Resolves {@link instruction} for the current context.
   *
   * Mirrors `LlmAgent.canonicalInstruction`, including its return shape:
   * `requireStateInjection` is true for a plain string and false for an
   * `InstructionProvider`, which manages state itself.
   */
  async canonicalInstruction(
    ctx: ReadonlyContext,
  ): Promise<{instruction: string; requireStateInjection: boolean}> {
    if (typeof this.instruction === 'string') {
      return {instruction: this.instruction, requireStateInjection: true};
    }
    return {
      instruction: await this.instruction(ctx),
      requireStateInjection: false,
    };
  }

  /**
   * Resolves {@link tools} into interaction tools, server-side only.
   *
   * A raw genai `Tool` passes through the interactions converter; an ADK
   * built-in tool configures itself onto a scratch request first; a
   * {@link RemoteMcpServer} becomes an MCP server tool whose headers are minted
   * now.
   *
   * @throws Error if a tool is client-executed or is a raw `mcpServers` config.
   */
  private async resolveBackendTools(
    ctx: InvocationContext,
  ): Promise<Interactions.Tool[]> {
    // The scratch request carries no model and is flagged as a managed agent,
    // so a built-in tool that normally gates on a Gemini model still resolves.
    // Nothing here is sent: the real call names the agent instead.
    const llmRequest: LlmRequest = {
      contents: [],
      config: {},
      liveConnectConfig: {},
      toolsDict: {},
      isManagedAgent: true,
    };
    const toolContext = new Context({invocationContext: ctx});
    const mcpParams: Interactions.Tool[] = [];

    for (const tool of this.tools) {
      if (isRemoteMcpServer(tool)) {
        mcpParams.push(
          buildMcpServerParam(tool, await resolveMcpHeaders(tool, ctx)),
        );
        continue;
      }

      if (isBaseTool(tool)) {
        // adk-js marks the tools the model runs itself, so the flag decides
        // directly. adk-python instead watches `tools_dict` grow, which would
        // misread every adk-js built-in tool as client-executed.
        if (!isInModelTool(tool)) {
          throw new Error(clientExecutedMessage(tool.name));
        }
        await tool.processLlmRequest({toolContext, llmRequest});
        continue;
      }

      if (typeof tool !== 'object' || tool === null) {
        throw new Error(clientExecutedMessage(String(tool)));
      }

      if (tool.mcpServers) {
        throw new Error(
          'Raw mcp_servers tools are not yet supported by ManagedAgent.',
        );
      }
      if (tool.functionDeclarations) {
        throw new Error(clientExecutedMessage(JSON.stringify(tool)));
      }
      if (!hasSupportedRawToolField(tool)) {
        throw new Error(
          `Unsupported raw Tool for ManagedAgent; supported server-side ` +
            `fields are googleSearch, codeExecution, urlContext, ` +
            `computerUse: ${JSON.stringify(tool)}`,
        );
      }
      llmRequest.config!.tools = [...(llmRequest.config!.tools ?? []), tool];
    }

    return [
      ...convertToolsConfigToInteractionsFormat(llmRequest.config ?? {}),
      ...mcpParams,
    ];
  }

  /** Maps a streamed response to an event authored by this agent. */
  private responseToEvent(
    ctx: InvocationContext,
    llmResponse: LlmResponse,
  ): Event {
    // The identity fields come last so a response field cannot overwrite them.
    return createEvent({
      ...llmResponse,
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
    });
  }

  /**
   * Builds the terminal error event for a failed turn.
   *
   * `turnComplete` is always set, so the Runner receives a terminal event even
   * when the interactions call fails.
   */
  private errorEvent(
    ctx: InvocationContext,
    error: {errorCode: string; errorMessage: string},
  ): Event {
    return createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      errorCode: error.errorCode,
      errorMessage: error.errorMessage,
      turnComplete: true,
    });
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Recovery and tool resolution run outside the try, so a configuration
    // error surfaces loudly instead of becoming an error event.
    const {interactionId: previousInteractionId, environmentId} =
      findPreviousInteractionState(ctx.session.events, this.name, ctx.branch);
    const environment = environmentId ?? this.environment;
    const input = ctx.userContent ? convertContentToSteps(ctx.userContent) : [];
    const tools = await this.resolveBackendTools(ctx);

    const readonlyContext = new ReadonlyContext(ctx);
    const {instruction, requireStateInjection} =
      await this.canonicalInstruction(readonlyContext);
    const systemInstruction = requireStateInjection
      ? await injectSessionState(instruction, readonlyContext)
      : instruction;

    const createParams: Omit<
      Interactions.CreateAgentInteractionParamsStreaming,
      'stream'
    > = {
      agent: this.agentId,
      input,
      // The Managed Agents workflow requires background execution. The agent
      // streams only, so the background result arrives over the open stream.
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
    if (previousInteractionId) {
      createParams.previous_interaction_id = previousInteractionId;
    }
    if (systemInstruction) {
      createParams.system_instruction = systemInstruction;
    }

    logger.info(
      `Sending request via interactions API, agent: ${this.agentId}, ` +
        `stream: true, previous_interaction_id: ${previousInteractionId}, ` +
        `environment: ${JSON.stringify(environment)}`,
    );
    logger.debug(`Interactions request: ${JSON.stringify(createParams)}`);

    const span = tracer.startSpan('managed_agent_interaction');
    try {
      yield* runAsyncGeneratorWithOtelContext<ManagedAgent, Event>(
        trace.setSpan(context.active(), span),
        this,
        async function* () {
          try {
            for await (const llmResponse of createInteractions(this.apiClient, {
              createParams,
              stream: true,
            })) {
              // The server always streams, but an intermediate partial only
              // reaches the caller in SSE mode. The default surfaces the
              // aggregated final response and any error, mirroring an LlmAgent.
              if (
                ctx.runConfig?.streamingMode === StreamingMode.SSE ||
                !llmResponse.partial
              ) {
                yield this.responseToEvent(ctx, llmResponse);
              }
            }
          } catch (error: unknown) {
            // Never rethrown: the Runner must always receive a terminal event.
            logger.error(
              `ManagedAgent interaction failed: ${formatError(error)}`,
            );
            const failure = asApiFailure(error);
            yield this.errorEvent(ctx, {
              errorCode: failure ? String(failure.status) : UNKNOWN_ERROR_CODE,
              errorMessage: failure ? failure.message : formatError(error),
            });
          }
        },
      );
    } finally {
      span.end();
    }
  }

  /**
   * Runs the agent as a workflow node, threading the node input into the user
   * content.
   *
   * A single-turn agent receives the parent's tool-call argument as
   * `nodeInput`; it becomes the agent's user content, so the turn sends it to
   * the interactions API. With no node input the behaviour is the base class's.
   *
   * Unlike adk-python, nothing is stamped onto the events here, for the reason
   * `BaseAgent.runImpl` gives: the TypeScript node runner already owns the
   * event author and the node path.
   */
  protected override async *runImpl(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    if (nodeInput === undefined || nodeInput === null) {
      yield* super.runImpl(ctx, nodeInput);
      return;
    }
    yield* this.runAsync(
      new InvocationContext({
        ...ctx.getInvocationContext(),
        userContent: nodeInputToUserContent(nodeInput),
      }),
    );
  }

  // eslint-disable-next-line require-yield -- the base class mandates an AsyncGenerator, and there is no live event to emit before rejecting the mode
  protected async *runLiveImpl(
    _ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    throw new Error(
      'ManagedAgent supports streaming interactions only; live mode is not ' +
        'supported.',
    );
  }
}
