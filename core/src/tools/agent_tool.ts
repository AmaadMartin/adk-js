/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionDeclaration, Schema, Type} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {Event} from '../events/event.js';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {Runner} from '../runner/runner.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {SchemaLike, toJsonSchema} from '../utils/schema.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {State} from '../sessions/state.js';

import {
  AGENT_TOOL_SIGNATURE_SYMBOL,
  isAgentTool,
} from './agent_tool_signature.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';
import {ForwardingArtifactService} from './forwarding_artifact_service.js';

export {isAgentTool};

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
 * Prefix marking a state key as ADK bookkeeping. Such a key stays in the
 * caller's session and never reaches a sub-agent.
 */
const ADK_INTERNAL_STATE_PREFIX = '_adk';

/** The parameters of an agent that declares no input schema. */
const REQUEST_PARAMETERS: Schema = {
  type: Type.OBJECT,
  properties: {request: {type: Type.STRING}},
  required: ['request'],
};

/** {@link REQUEST_PARAMETERS} as plain JSON Schema. */
const REQUEST_PARAMETERS_JSON_SCHEMA = toJsonSchema(REQUEST_PARAMETERS);

/** The wrapped agent's input schema in the genai form a declaration needs. */
function agentInputSchema(agent: BaseAgent): Schema | undefined {
  return isLlmAgent(agent) ? agent.inputSchema : undefined;
}

/**
 * The wrapped agent's input schema as the caller supplied it. A Zod schema
 * validates faithfully, where its genai translation may not, so validation and
 * JSON-schema rendering read this one.
 */
function agentInputSchemaSource(agent: BaseAgent): SchemaLike | undefined {
  return isLlmAgent(agent)
    ? (agent.inputSchemaSource ?? agent.inputSchema)
    : undefined;
}

/** Whether the wrapped agent constrains its output with a schema. */
function agentHasOutputSchema(agent: BaseAgent): boolean {
  return isLlmAgent(agent) && agent.outputSchema !== undefined;
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
    const jsonSchemaDeclaration = isFeatureEnabled(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
    );
    const declaration: FunctionDeclaration = {
      name: this.name,
      description: this.description,
    };

    if (jsonSchemaDeclaration) {
      const inputSchema = agentInputSchemaSource(this.agent);
      declaration.parametersJsonSchema = inputSchema
        ? toJsonSchema(inputSchema)
        : REQUEST_PARAMETERS_JSON_SCHEMA;
    } else {
      // The agent's input schema is used as is; it is neither validated nor
      // transformed, unlike the equivalent path in Python ADK.
      declaration.parameters =
        agentInputSchema(this.agent) ?? REQUEST_PARAMETERS;
    }

    if (this.apiVariant !== GoogleLLMVariant.GEMINI_API) {
      const hasOutputSchema = agentHasOutputSchema(this.agent);
      if (jsonSchemaDeclaration) {
        declaration.responseJsonSchema = {
          type: hasOutputSchema ? 'object' : 'string',
        };
      } else {
        declaration.response = {
          type: hasOutputSchema ? Type.OBJECT : Type.STRING,
        };
      }
    }

    return declaration;
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    if (this.skipSummarization) {
      toolContext.actions.skipSummarization = true;
    }

    const hasInputSchema = agentInputSchema(this.agent) !== undefined;
    const content: Content = {
      role: 'user',
      parts: [
        {
          text: hasInputSchema
            ? JSON.stringify(args)
            : (args['request'] as string),
        },
      ],
    };

    // Session and telemetry backends key on the app name, so the sub-agent run
    // is filed under the caller's app rather than under the sub-agent's name.
    const childAppName =
      toolContext.invocationContext.appName ?? this.agent.name;

    const runner = new Runner({
      appName: childAppName,
      agent: this.agent,
      artifactService: new ForwardingArtifactService(toolContext),
      // A fresh service per call: the sub-agent reads neither the caller's
      // transcript nor its own previous turns.
      sessionService: new InMemorySessionService(),
      memoryService:
        toolContext.invocationContext.memoryService ??
        new InMemoryMemoryService(),
      credentialService: toolContext.invocationContext.credentialService,
    });

    const state = Object.fromEntries(
      Object.entries(toolContext.state.toRecord()).filter(
        ([key]) => !key.startsWith(ADK_INTERNAL_STATE_PREFIX),
      ),
    );

    const session = await runner.sessionService.createSession({
      appName: childAppName,
      userId: toolContext.invocationContext.userId,
      state,
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

    const hasOutputSchema = agentHasOutputSchema(this.agent);
    // Exclude thoughts from the merged text.
    const mergedText = lastEvent.content.parts
      .filter((part) => !part.thought)
      .map((part) => part.text)
      .filter((text) => text)
      .join('\n');

    // The output is not validated against the output schema, unlike the
    // equivalent path in Python ADK.
    return hasOutputSchema ? JSON.parse(mergedText) : mergedText;
  }
}
