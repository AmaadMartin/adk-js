/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionDeclaration, Part, Type} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {isLlmAgent, LlmAgent} from '../agents/llm_agent.js';
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
 * Resolves the agent whose schema an `AgentTool` speaks for. An `LlmAgent`
 * answers for itself; any other agent resolves through the sub-agent at
 * `edge`, because a composite agent reads its input at the first leg and
 * produces its output at the last. Mirrors `_get_input_schema` and
 * `_get_output_schema` in adk-python's `agent_tool.py`.
 */
function resolveSchemaAgent(
  agent: BaseAgent,
  edge: 'first' | 'last',
): LlmAgent | undefined {
  if (isLlmAgent(agent)) {
    return agent;
  }
  const subAgents = agent.subAgents ?? [];
  const next =
    edge === 'first' ? subAgents[0] : subAgents[subAgents.length - 1];
  return next ? resolveSchemaAgent(next, edge) : undefined;
}

/**
 * Drops null-valued properties from a serialized value, matching
 * `exclude_none=True` in adk-python's `agent_tool.py`.
 */
function withoutNulls(_key: string, value: unknown): unknown {
  return value === null ? undefined : value;
}

/**
 * Renders `args` as prompt text for an agent that declares no input schema.
 *
 * A string `request` argument passes through unchanged, an empty one
 * included. Anything else is serialized with its keys in a fixed order, so the
 * same arguments always produce the same text. A `request` the model filled
 * with something other than a string takes that same path rather than a cast,
 * because the declared schema does not bind the model. Mirrors the no-schema
 * branch of `run_async` in adk-python's `agent_tool.py`.
 */
function requestText(args: Record<string, unknown>): string {
  const request = args['request'];
  if (typeof request === 'string') {
    return request;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) {
    sorted[key] = args[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Returns the reader-visible text of `part`, including the result of a code
 * execution. Mirrors `_part_to_text` in adk-python's `agent_tool.py`.
 */
function partToText(part: Part): string {
  if (part.text) {
    return part.text;
  }
  const output = part.codeExecutionResult?.output;
  if (output) {
    return output.replace(/\n+$/, '');
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

    const inputSchema = resolveSchemaAgent(this.agent, 'first')?.inputSchema;
    if (inputSchema) {
      declaration = {
        name: this.name,
        description: this.description,
        // TODO(b/425992518): We should not use the agent's input schema as is.
        // It should be validated and possibly transformed. Consider similar
        // logic to one we have in Python ADK.
        parameters: inputSchema,
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
      const outputSchema = resolveSchemaAgent(this.agent, 'last')?.outputSchema;
      declaration.response = outputSchema
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

    const inputAgent = resolveSchemaAgent(this.agent, 'first');
    const inputSchema =
      inputAgent?.inputSchemaSource ?? inputAgent?.inputSchema;
    const outputSchema = resolveSchemaAgent(this.agent, 'last')?.outputSchema;
    const content: Content = {
      role: 'user',
      parts: [
        {
          // The sub-agent re-validates this text against the same schema, so
          // it must stay a bare JSON document with no surrounding prose.
          text: inputSchema
            ? JSON.stringify(parseWithSchema(inputSchema, args), withoutNulls)
            : requestText(args),
        },
      ],
    };

    const seedState = Object.fromEntries(
      Object.entries(toolContext.state.toRecord()).filter(
        ([key]) => !key.startsWith(State.ADK_INTERNAL_PREFIX),
      ),
    );

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
      state: seedState,
    });

    if (toolContext.abortSignal?.aborted) {
      return '';
    }

    let lastContent: Content | undefined;
    let lastErrorMessage: string | undefined;
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
      // A run can end on an event that carries no content, such as one that
      // only reports an error. Keep the last event that did carry content.
      if (event.content) {
        lastContent = event.content;
      }
    }

    if (!lastContent?.parts?.length) {
      return lastErrorMessage ?? '';
    }

    // Exclude thoughts from the merged text.
    const mergedText = lastContent.parts
      .filter((part) => !part.thought)
      .map(partToText)
      .filter((text) => text)
      .join('\n');

    // An error message tells the calling model why the sub-agent produced
    // nothing, so it beats an empty result.
    if (!mergedText && lastErrorMessage) {
      return lastErrorMessage;
    }

    // TODO - b/425992518: In case of output schema, the output should be
    // validated. Consider similar logic to one we have in Python ADK.
    return outputSchema ? JSON.parse(mergedText) : mergedText;
  }
}
