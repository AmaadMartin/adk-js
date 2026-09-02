/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionDeclaration, Type} from '@google/genai';

import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {RunConfig, StreamingMode} from '../agents/run_config.js';
import {
  ToolErrorType,
  ToolExecutionError,
} from '../errors/tool_execution_error.js';
import {Event} from '../events/event.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {Runner} from '../runner/runner.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {stableJsonStringify} from '../utils/json_utils.js';
import {resolveFullyQualifiedName} from '../utils/module_utils.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {State} from '../sessions/state.js';

import {BaseTool, RunAsyncToolRequest} from './base_tool.js';
import {ForwardingArtifactService} from './forwarding_artifact_service.js';

/**
 * The configuration of the agent tool.
 */
export interface AgentToolConfig {
  /**
   * The reference to the agent instance.
   */
  agent: BaseAgent;

  /**
   * Whether to skip summarization of the agent output.
   */
  skipSummarization?: boolean;
}

/**
 * A reference to an agent named in a configuration file. Exactly one field is
 * set.
 */
export interface AgentRefConfig {
  /** Fully-qualified name of an agent instance defined in code. */
  code?: string;

  /** Path to the agent's own config file, relative to the referring file. */
  configPath?: string;
}

/**
 * The declarative configuration of an {@link AgentTool}, as a configuration
 * file declares it.
 *
 * Named for its contents rather than for the tool because
 * {@link AgentToolConfig} already names the constructor parameter object,
 * which holds a live agent. Python spells the same pair `ToolArgsConfig` and
 * `AgentToolConfig`.
 */
export interface AgentToolArgsConfig {
  /** The agent to wrap. */
  agent: AgentRefConfig;

  /** Whether to skip summarization of the agent output. */
  skipSummarization?: boolean;
}

/**
 * Derives the run config of the nested run from the caller's.
 *
 * The wrapped agent runs as part of the caller's invocation, so it obeys the
 * caller's run settings. Two of them are the caller's alone and are dropped:
 *
 * - `supportCfc` describes how the caller's own model executes. Handing it to
 *   another agent replaces that agent's code executor, and the nested
 *   {@link Runner} then refuses any model that is not a Gemini 2 one.
 * - A streaming mode makes the nested run emit partial events. Only the last
 *   event's content becomes the tool result, so a caller streaming without
 *   aggregation would leave a partial chunk as the whole answer.
 *
 * Everything else, `maxLlmCalls` included, is forwarded untouched. The call
 * count is per-invocation, so the caller's ceiling bounds the nested run
 * rather than being shared with the caller's own.
 *
 * @param parent The caller's run config, if it set one.
 * @return The caller's own config when no override applies, so the caller's
 *   object is forwarded rather than copied. Never the mutated caller's object.
 */
function nestedRunConfig(parent?: RunConfig): RunConfig | undefined {
  if (parent === undefined) {
    return undefined;
  }
  let nested = parent;
  if (nested.supportCfc) {
    nested = {...nested, supportCfc: false};
  }
  if ((nested.streamingMode ?? StreamingMode.NONE) !== StreamingMode.NONE) {
    nested = {...nested, streamingMode: StreamingMode.NONE};
  }
  return nested;
}

/**
 * Returns the prompt text for an agent that declares no input schema.
 *
 * A `request` argument is the prompt itself, empty string included. Anything
 * else is the whole argument object, serialized with its keys sorted so that
 * two calls differing only in key order produce identical text.
 */
function promptTextFromArgs(args: Record<string, unknown>): string {
  const request = args['request'];
  return typeof request === 'string' ? request : stableJsonStringify(args);
}

/** Resolves the agent a configuration file references. */
async function resolveAgentReference(
  ref: AgentRefConfig,
  configAbsPath: string,
): Promise<BaseAgent> {
  if ((ref.code === undefined) === (ref.configPath === undefined)) {
    throw new ToolExecutionError(
      'An agent reference must set exactly one of `code` and `configPath`.',
      ToolErrorType.BAD_REQUEST,
    );
  }
  if (ref.code === undefined) {
    throw new ToolExecutionError(
      'A `configPath` agent reference is not supported: adk-js has no agent ' +
        'config loader. Reference the agent in code with `code` instead.',
      ToolErrorType.BAD_REQUEST,
    );
  }
  const resolved = await resolveFullyQualifiedName(ref.code, configAbsPath);
  if (!isBaseAgent(resolved)) {
    throw new ToolExecutionError(
      `Agent reference \`${ref.code}\` does not resolve to an agent.`,
      ToolErrorType.BAD_REQUEST,
    );
  }
  return resolved;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
const AGENT_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.agentTool');

/**
 * Type guard to check if an object is an instance of BaseTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseTool, false otherwise.
 */
export function isAgentTool(obj: unknown): obj is AgentTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    AGENT_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[AGENT_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A tool that wraps an agent.
 *
 * This tool allows an agent to be called as a tool within a larger
 * application. The agent's input schema is used to define the tool's input
 * parameters, and the agent's output is returned as the tool's result.
 *
 *  @param config: The configuration of the agent tool.
 */
export class AgentTool extends BaseTool {
  /** A unique symbol to identify ADK agent tool class. */
  readonly [AGENT_TOOL_SIGNATURE_SYMBOL] = true;

  private readonly agent: BaseAgent;

  private readonly skipSummarization: boolean;

  constructor(config: AgentToolConfig) {
    super({
      name: config.agent.name,
      description: config.agent.description || '',
    });
    this.agent = config.agent;
    this.skipSummarization = config.skipSummarization || false;
  }

  /**
   * Builds a tool from the declarative configuration of a config file.
   *
   * The method is asynchronous because JavaScript loads a module
   * asynchronously. The adk-python counterpart is synchronous only because
   * `importlib` is.
   *
   * @param config The tool's declared configuration.
   * @param configAbsPath Absolute path of the config file the declaration came
   *   from. A relative module specifier resolves against its directory.
   * @return The configured tool.
   * @throws {ToolExecutionError} When the agent reference does not set exactly
   *   one of `code` and `configPath`, names a `configPath`, or resolves to a
   *   value that is not an agent.
   * @throws {InputValidationError} When `code` names a module or an export
   *   that does not resolve.
   */
  static async fromConfig(
    config: AgentToolArgsConfig,
    configAbsPath: string,
  ): Promise<AgentTool> {
    const agent = await resolveAgentReference(config.agent, configAbsPath);
    return new AgentTool({
      agent,
      skipSummarization: config.skipSummarization,
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    let declaration: FunctionDeclaration;

    if (isLlmAgent(this.agent) && this.agent.inputSchema) {
      declaration = {
        name: this.name,
        description: this.description,
        // TODO(b/425992518): We should not use the agent's input schema as is.
        // It should be validated and possibly transformed. Consider similar
        // logic to one we have in Python ADK.
        parameters: this.agent.inputSchema,
      };
    } else {
      declaration = {
        name: this.name,
        description: this.description,
        parameters: {
          type: Type.OBJECT,
          properties: {
            'request': {
              type: Type.STRING,
            },
          },
          required: ['request'],
        },
      };
    }

    if (this.apiVariant !== GoogleLLMVariant.GEMINI_API) {
      const hasOutputSchema = isLlmAgent(this.agent) && this.agent.outputSchema;
      declaration.response = hasOutputSchema
        ? {type: Type.OBJECT}
        : {type: Type.STRING};
    }

    return declaration;
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    // Note: skipSummarization is intentionally not propagated to
    // toolContext.actions here. Setting it on the shared EventActions would
    // leak onto the tool-response event returned to the parent agent, causing
    // isFinalResponse() to treat that event as terminal and prematurely
    // terminate the parent's run loop. The sub-agent's output is already
    // returned verbatim below, which is the intended effect of
    // skipSummarization.

    const hasInputSchema = isLlmAgent(this.agent) && this.agent.inputSchema;
    const content: Content = {
      role: 'user',
      parts: [
        {
          // TODO(b/425992518): Should be validated. Consider similar
          // logic to one we have in Python ADK.
          text: hasInputSchema
            ? JSON.stringify(args)
            : promptTextFromArgs(args),
        },
      ],
    };

    const runner = new Runner({
      appName: this.agent.name,
      agent: this.agent,
      artifactService: new ForwardingArtifactService(toolContext),
      sessionService:
        toolContext.invocationContext.sessionService ??
        new InMemorySessionService(),
      memoryService:
        toolContext.invocationContext.memoryService ??
        new InMemoryMemoryService(),
      credentialService: toolContext.invocationContext.credentialService,
    });

    const session = await runner.sessionService.getOrCreateSession({
      appName: this.agent.name,
      userId: toolContext.invocationContext.userId,
      sessionId: toolContext.invocationContext.session.id,
      state: toolContext.state.toRecord(),
    });

    if (toolContext.abortSignal?.aborted) {
      return '';
    }

    let lastEvent: Event | undefined;
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: content,
      abortSignal: toolContext.abortSignal,
      runConfig: nestedRunConfig(toolContext.invocationContext.runConfig),
    })) {
      if (toolContext.abortSignal?.aborted) {
        return;
      }

      if (event.actions.stateDelta) {
        const filteredDelta = Object.fromEntries(
          Object.entries(event.actions.stateDelta).filter(
            ([key]) => !key.startsWith(State.TEMP_PREFIX),
          ),
        );
        if (Object.keys(filteredDelta).length > 0) {
          toolContext.state.update(filteredDelta);
        }
      }

      lastEvent = event;
    }

    if (!lastEvent?.content?.parts?.length) {
      return '';
    }

    const hasOutputSchema = isLlmAgent(this.agent) && this.agent.outputSchema;
    // Exclude thoughts from the merged text.
    const mergedText = lastEvent.content.parts
      .filter((part) => !part.thought)
      .map((part) => part.text)
      .filter((text) => text)
      .join('\n');

    // TODO - b/425992518: In case of output schema, the output should be
    // validated. Consider similar logic to one we have in Python ADK.
    return hasOutputSchema ? JSON.parse(mergedText) : mergedText;
  }
}
