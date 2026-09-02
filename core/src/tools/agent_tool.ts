/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionDeclaration, Type} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {RunConfig, StreamingMode} from '../agents/run_config.js';
import {Event} from '../events/event.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {Runner} from '../runner/runner.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {parseWithSchema} from '../utils/schema.js';
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

  override _getDeclaration(): FunctionDeclaration {
    let declaration: FunctionDeclaration;

    if (isLlmAgent(this.agent) && this.agent.inputSchema) {
      declaration = {
        name: this.name,
        // The agent's description, never the input schema's: a schema
        // describes the arguments, not what calling the agent does.
        description: this.description,
        // `LlmAgent.inputSchema` is the schema as supplied, already converted
        // into the genai dialect the declaration needs.
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

    // The source form is preferred: converting a schema into the genai dialect
    // drops the Zod refinements and transforms that validation needs.
    const inputSchema = isLlmAgent(this.agent)
      ? (this.agent.inputSchemaSource ?? this.agent.inputSchema)
      : undefined;
    const content: Content = {
      role: 'user',
      parts: [
        {
          // With a schema the text must stay a bare JSON document: the wrapped
          // agent re-validates it against that same schema, so any prose here
          // fails that parse. Validating here catches arguments the model got
          // wrong at the tool boundary instead of inside the sub-agent.
          text: inputSchema
            ? JSON.stringify(parseWithSchema(inputSchema, args))
            : (args['request'] as string),
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

    try {
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
        runConfig: nestedRunConfig(toolContext.invocationContext.runConfig),
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

      // With an output schema the merged text is parsed, but it is not yet
      // validated against that schema.
      return hasOutputSchema ? JSON.parse(mergedText) : mergedText;
    } finally {
      // The runner is local to this call, so nothing else holds what it holds:
      // release it however the run ended, including the aborted early returns.
      await runner.close();
    }
  }
}

/**
 * The run config for the nested run, derived from the caller's.
 *
 * The wrapped agent runs as part of the caller's invocation, so it obeys the
 * caller's run settings. Without this the nested run falls back to the
 * `RunConfig` defaults: a `maxLlmCalls` ceiling of 500 whatever the caller
 * asked for, and none of the caller's own settings. The count stays
 * per-invocation, so the ceiling bounds the nested run rather than being
 * shared with the caller's.
 *
 * Two settings do not carry over. `supportCfc` describes how the caller's own
 * model executes; handing it to another agent replaces that agent's code
 * executor, and refuses to run it unless its model is a Gemini 2 one. And only
 * the last event's content becomes the tool result, so a streamed nested run
 * would leave a partial chunk as the answer — the nested run is always unary.
 *
 * The caller's config is never mutated, and is forwarded as-is when neither
 * override applies.
 */
function nestedRunConfig(runConfig?: RunConfig): RunConfig | undefined {
  if (!runConfig) {
    return undefined;
  }
  const unary =
    runConfig.streamingMode === undefined ||
    runConfig.streamingMode === StreamingMode.NONE;
  if (!runConfig.supportCfc && unary) {
    return runConfig;
  }
  return {...runConfig, supportCfc: false, streamingMode: StreamingMode.NONE};
}
