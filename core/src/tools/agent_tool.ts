/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionDeclaration, Schema, Type} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {Event} from '../events/event.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {Runner} from '../runner/runner.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {formatError} from '../utils/error_utils.js';
import {parseWithSchema, SchemaLike, toJsonSchema} from '../utils/schema.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';
import {runNodeFromToolContext} from '../workflow/run_node_from_tool.js';

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
 * The parameters a task sub-agent gets when it declares no input schema.
 * Mirrors adk-python's `_DefaultTaskInput`.
 */
const DEFAULT_TASK_INPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    request: {
      type: Type.STRING,
      description: 'Detailed instructions or context for the task sub-agent.',
    },
  },
  required: ['request'],
};

/**
 * Appended to a task tool's description so the model does not schedule a
 * delegated run alongside other calls.
 */
const TASK_DELEGATION_WARNING =
  '\nIMPORTANT: This tool delegates execution to a specialized agent.' +
  ' Do NOT call this tool in parallel with any other tools.';

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

  protected readonly agent: BaseAgent;

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

/**
 * Runs `agent` as a child node of the caller's own invocation and returns the
 * node output.
 *
 * A failure comes back as text rather than as a throw: the model can retry a
 * described failure, where a throw ends the caller's turn.
 */
async function runAgentAsChildNode(
  agent: BaseAgent,
  toolName: string,
  {args, toolContext}: RunAsyncToolRequest,
): Promise<unknown> {
  const inputSchema = agentInputSchemaSource(agent);
  let nodeInput: unknown;
  if (inputSchema) {
    try {
      nodeInput = parseWithSchema(inputSchema, args);
    } catch (error: unknown) {
      return `Error validating input: ${formatError(error)}`;
    }
  } else {
    nodeInput = args['request'];
  }

  try {
    const child = await runNodeFromToolContext({
      toolContext,
      node: agent,
      input: nodeInput,
      toolName,
    });
    return child.output;
  } catch (error: unknown) {
    return `Error running sub-agent: ${formatError(error)}`;
  }
}

/**
 * An {@link AgentTool} that runs the wrapped agent inline, as a child node of
 * the caller's own invocation, instead of in a nested runner.
 *
 * The child shares the caller's session and streams its events into the
 * caller's event queue. It runs on a branch scoped to this function call
 * (`<callerBranch>.<agentName>@<functionCallId>`), so its events stay
 * distinguishable from the caller's.
 *
 * `LlmAgent` builds one of these for each `mode: 'single_turn'` sub-agent, so a
 * sub-agent reaches the parent model as a callable tool. Mirrors adk-python's
 * `_SingleTurnAgentTool`.
 */
export class SingleTurnAgentTool extends AgentTool {
  override runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return runAgentAsChildNode(this.agent, this.name, request);
  }
}

/**
 * An {@link AgentTool} that delegates a whole task to the wrapped agent.
 *
 * Execution matches {@link SingleTurnAgentTool}: the agent runs inline, as a
 * child node of the caller's invocation. Because the agent declares
 * `mode: 'task'`, that node run drives the `finish_task` loop and the tool
 * result is the task output.
 *
 * The declaration is what differs. It carries the agent's input schema or a
 * default `request` parameter, and a description warning the model not to call
 * the tool in parallel. Mirrors adk-python's `_TaskAgentTool`.
 */
export class TaskAgentTool extends AgentTool {
  override _getDeclaration(): FunctionDeclaration {
    const inputSchema =
      agentInputSchemaSource(this.agent) ?? DEFAULT_TASK_INPUT_SCHEMA;
    const declaration: FunctionDeclaration = {
      name: this.name,
      description: `${this.description}${TASK_DELEGATION_WARNING}`.trim(),
      parametersJsonSchema: toJsonSchema(inputSchema),
    };

    if (this.apiVariant !== GoogleLLMVariant.GEMINI_API) {
      declaration.responseJsonSchema = {
        type:
          isLlmAgent(this.agent) && this.agent.outputSchema
            ? 'object'
            : 'string',
      };
    }

    return declaration;
  }

  override runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return runAgentAsChildNode(this.agent, this.name, request);
  }
}
