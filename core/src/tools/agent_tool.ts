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
import {stableJsonStringify} from '../utils/json_utils.js';
import {parseWithSchema, SchemaLike} from '../utils/schema.js';
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
 * The schema the wrapped agent validates its input against, in the form the
 * author supplied.
 *
 * The source form is preferred over the agent's normalized `inputSchema`
 * because the conversion into the genai dialect is lossy: a Zod refinement or
 * custom error message has no genai equivalent.
 */
function agentInputSchema(agent: BaseAgent): SchemaLike | undefined {
  if (!isLlmAgent(agent)) {
    return undefined;
  }
  return agent.inputSchemaSource ?? agent.inputSchema;
}

/**
 * The run config the wrapped agent runs under: the caller's, with the two
 * settings that cannot cross the boundary overridden.
 *
 * CFC (Compositional Function Calling) describes how the caller's own model
 * executes. Handing it to another agent switches that agent onto the live API
 * path, which only works if its model happens to support CFC. And only the
 * last nested event's content becomes the tool result, so a streamed nested
 * run could leave a partial chunk as the answer — the nested run is always
 * unary.
 *
 * The caller's own config is never mutated: the overrides go on a copy. Both
 * are applied unconditionally, because they are the values `createRunConfig`
 * defaults to anyway when the caller left them unset.
 */
function nestedRunConfig(callerConfig?: RunConfig): RunConfig | undefined {
  if (!callerConfig) {
    return undefined;
  }
  return {
    ...callerConfig,
    supportCfc: false,
    streamingMode: StreamingMode.NONE,
  };
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
        description: this.description,
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

    const inputSchema = agentInputSchema(this.agent);
    let requestText: string;
    if (inputSchema) {
      // A bare JSON document: the sub-agent re-validates this same text
      // against this same schema, so any prose here fails that parse.
      requestText = JSON.stringify(parseWithSchema(inputSchema, args));
    } else {
      const request = args['request'];
      requestText =
        typeof request === 'string' ? request : stableJsonStringify(args);
    }
    const content: Content = {
      role: 'user',
      parts: [{text: requestText}],
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

      // TODO - the output should be validated against the agent's output
      // schema. Consider similar logic to one we have in Python ADK.
      return hasOutputSchema ? JSON.parse(mergedText) : mergedText;
    } finally {
      await runner.close();
    }
  }
}
