/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionDeclaration,
  GroundingMetadata,
  Part,
  Type,
} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {isLlmAgent, LlmAgent} from '../agents/llm_agent.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {Runner} from '../runner/runner.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {State} from '../sessions/state.js';
import {parseWithSchema, stripJsonCodeFence} from '../utils/schema.js';

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

  /**
   * Whether to propagate the parent runner's plugins into the wrapped agent's
   * runner. Defaults to true. Set it to false to run the wrapped agent with an
   * isolated plugin environment.
   */
  includePlugins?: boolean;

  /**
   * Whether to publish the wrapped agent's grounding metadata to the caller's
   * state under `temp:_adk_grounding_metadata`. Defaults to false.
   */
  propagateGroundingMetadata?: boolean;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
const AGENT_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.agentTool');

/**
 * The state key the wrapped agent's grounding metadata is published under.
 * Spelled exactly as adk-python spells it, so both SDKs agree on the key.
 */
const GROUNDING_METADATA_STATE_KEY = `${State.TEMP_PREFIX}_adk_grounding_metadata`;

/** The trailing newlines of a code execution result. */
const TRAILING_NEWLINES_PATTERN = /\n+$/;

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
 * The `LlmAgent` a wrapped agent takes a schema from: itself, or the sub-agent
 * at `edge`, recursively. Mirrors adk-python's `_get_input_schema`, which
 * follows the first sub-agent, and `_get_output_schema`, which follows the
 * last.
 */
function schemaAgent(
  agent: BaseAgent,
  edge: 'first' | 'last',
): LlmAgent | undefined {
  if (isLlmAgent(agent)) {
    return agent;
  }
  const next = agent.subAgents?.at(edge === 'first' ? 0 : -1);
  return next ? schemaAgent(next, edge) : undefined;
}

/** The user-visible text of a part, including code execution output. */
function partToText(part: Part): string {
  if (part.text) {
    return part.text;
  }
  const output = part.codeExecutionResult?.output;
  if (output) {
    return output.replace(TRAILING_NEWLINES_PATTERN, '');
  }
  return part.executableCode?.code ?? '';
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

  private readonly includePlugins: boolean;

  private readonly propagateGroundingMetadata: boolean;

  constructor(config: AgentToolConfig) {
    super({
      name: config.agent.name,
      description: config.agent.description || '',
    });
    this.agent = config.agent;
    this.skipSummarization = config.skipSummarization || false;
    this.includePlugins = config.includePlugins ?? true;
    this.propagateGroundingMetadata =
      config.propagateGroundingMetadata ?? false;
  }

  override _getDeclaration(): FunctionDeclaration {
    const inputSchema = schemaAgent(this.agent, 'first')?.inputSchema;
    const declaration: FunctionDeclaration = {
      name: this.name,
      description: this.description,
      parameters: inputSchema ?? {
        type: Type.OBJECT,
        properties: {
          'request': {
            type: Type.STRING,
          },
        },
        required: ['request'],
      },
    };

    if (this.apiVariant !== GoogleLLMVariant.GEMINI_API) {
      declaration.response = schemaAgent(this.agent, 'last')?.outputSchema
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

    const inputAgent = schemaAgent(this.agent, 'first');
    const inputSchema =
      inputAgent?.inputSchemaSource ?? inputAgent?.inputSchema;
    const request = args['request'];
    const content: Content = {
      role: 'user',
      parts: [
        {
          // With a schema the text must stay a bare JSON document: the wrapped
          // agent re-validates it against that same schema.
          text: inputSchema
            ? JSON.stringify(parseWithSchema(inputSchema, args))
            : typeof request === 'string'
              ? request
              : JSON.stringify(args),
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
      // The caller keeps ownership of these plugins: adk-js has no plugin
      // close lifecycle, so the sub-runner cannot tear them down.
      plugins: this.includePlugins
        ? toolContext.invocationContext.pluginManager?.listPlugins()
        : undefined,
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

    let lastContent: Content | undefined;
    let lastErrorMessage: string | undefined;
    let lastGroundingMetadata: GroundingMetadata | undefined;
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: content,
      abortSignal: toolContext.abortSignal,
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

      if (event.errorMessage) {
        lastErrorMessage = event.errorMessage;
      }
      if (event.content) {
        lastContent = event.content;
        lastGroundingMetadata = event.groundingMetadata;
      }
    }

    if (!lastContent?.parts) {
      return lastErrorMessage ?? '';
    }

    // Exclude thoughts from the merged text.
    const mergedText = lastContent.parts
      .filter((part) => !part.thought)
      .map(partToText)
      .filter((text) => text)
      .join('\n');
    if (!mergedText && lastErrorMessage) {
      return lastErrorMessage;
    }

    const outputAgent = schemaAgent(this.agent, 'last');
    const result = outputAgent?.outputSchema
      ? outputAgent.validateOutput(JSON.parse(stripJsonCodeFence(mergedText)))
      : mergedText;

    if (this.propagateGroundingMetadata && lastGroundingMetadata) {
      toolContext.state.set(
        GROUNDING_METADATA_STATE_KEY,
        lastGroundingMetadata,
      );
    }

    return result;
  }
}
