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
  Schema,
  Type,
} from '@google/genai';

import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {isLlmAgent, LlmAgent} from '../agents/llm_agent.js';
import {RunConfig, StreamingMode} from '../agents/run_config.js';
import {
  ToolErrorType,
  ToolExecutionError,
} from '../errors/tool_execution_error.js';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {Runner} from '../runner/runner.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {formatError} from '../utils/error_utils.js';
import {stableJsonStringify} from '../utils/json_utils.js';
import {resolveFullyQualifiedName} from '../utils/module_utils.js';
import {
  parseWithSchema,
  SchemaLike,
  stripJsonCodeFence,
  toJsonSchema,
} from '../utils/schema.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';
import {runNodeFromToolContext} from '../workflow/run_node_from_tool.js';

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

/**
 * The state key the wrapped agent's grounding metadata is published under.
 * Spelled exactly as adk-python spells it, so both SDKs agree on the key.
 */
const GROUNDING_METADATA_STATE_KEY = `${State.TEMP_PREFIX}_adk_grounding_metadata`;

/** The trailing newlines of a code execution result. */
const TRAILING_NEWLINES_PATTERN = /\n+$/;

/** The wrapped agent's input schema in the genai form a declaration needs. */
function agentInputSchema(agent: BaseAgent): Schema | undefined {
  return schemaAgent(agent, 'first')?.inputSchema;
}

/**
 * The wrapped agent's input schema as the caller supplied it. A Zod schema
 * validates faithfully, where its genai translation may not, so validation and
 * JSON-schema rendering read this one.
 */
function agentInputSchemaSource(agent: BaseAgent): SchemaLike | undefined {
  const source = schemaAgent(agent, 'first');
  return source?.inputSchemaSource ?? source?.inputSchema;
}

/** Whether the wrapped agent constrains its output with a schema. */
function agentHasOutputSchema(agent: BaseAgent): boolean {
  return schemaAgent(agent, 'last')?.outputSchema !== undefined;
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
 * The run config the wrapped agent runs under: the caller's, with the two
 * settings that cannot cross the boundary overridden.
 *
 * Without this the nested run falls back to the `RunConfig` defaults: a
 * `maxLlmCalls` ceiling of 500 whatever the caller asked for, and none of the
 * caller's own settings. The count stays per-invocation, so the ceiling bounds
 * the nested run rather than being shared with the caller's.
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

  protected readonly agent: BaseAgent;

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
      // The declaration carries the agent's input schema as it stands. The
      // arguments a call brings back are validated in `runAsync`.
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

    const inputSchema = agentInputSchemaSource(this.agent);
    const request = args['request'];
    const content: Content = {
      role: 'user',
      parts: [
        {
          // With a schema the text must stay a bare JSON document: the wrapped
          // agent re-validates it against that same schema, so any prose here
          // fails that parse. Validating here catches arguments the model got
          // wrong at the tool boundary instead of inside the sub-agent.
          // Without a schema, and without a string `request`, the keys are
          // sorted so that the same arguments always produce the same message.
          text: inputSchema
            ? JSON.stringify(parseWithSchema(inputSchema, args))
            : typeof request === 'string'
              ? request
              : stableJsonStringify(args),
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
      // The caller keeps ownership of these plugins: the sub-runner releases
      // its own toolsets and nothing else.
      plugins: this.includePlugins
        ? toolContext.invocationContext.pluginManager?.listPlugins()
        : undefined,
    });

    try {
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

      let lastContent: Content | undefined;
      let lastErrorMessage: string | undefined;
      let lastGroundingMetadata: GroundingMetadata | undefined;
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
    } finally {
      // Release the toolsets the wrapped agent holds, on every exit: a normal
      // run, an abort, and a throw. The session service and the plugins belong
      // to the caller, which is still using them.
      await runner.closeToolsets();
    }
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
        type: agentHasOutputSchema(this.agent) ? 'object' : 'string',
      };
    }

    return declaration;
  }

  override runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return runAgentAsChildNode(this.agent, this.name, request);
  }
}
