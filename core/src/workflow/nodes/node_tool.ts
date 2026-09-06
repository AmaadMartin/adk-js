/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';

import {isBaseAgent} from '../../agents/base_agent.js';
import {Context} from '../../agents/context.js';
import {BaseTool, RunAsyncToolRequest} from '../../tools/base_tool.js';
import {formatError} from '../../utils/error_utils.js';
import {parseWithSchema, toJsonSchema} from '../../utils/schema.js';
import {
  isZodObject,
  isZodSchema,
  zodObjectToSchema,
} from '../../utils/simple_zod_to_json.js';
import {BaseNode} from '../base_node.js';
import {isDynamicNodeFailError, isInvocationAbortedError} from '../errors.js';
import {NodeContext} from '../node_context.js';
import {executeChildNode} from '../node_runner.js';
import {isFunctionNode} from './function_node.js';

/**
 * A unique symbol branding {@link NodeTool} instances (see `isNodeTool`).
 */
const NODE_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.workflow.nodeTool');

/**
 * Maximum nesting depth for node-as-tool executions, guarding against
 * `node -> tool -> node` recursion (a node exposed as a tool whose agent can
 * call that same tool again — unbounded model + tool spend otherwise).
 */
const MAX_NODE_TOOL_DEPTH = 8;

/**
 * Wraps a scalar JSON Schema under a single `request` property: the GenAI API
 * accepts an object-typed parameter schema only. Mirrors
 * `_node_tool.py::_get_declaration`.
 */
function wrapScalarSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {request: schema},
    required: ['request'],
  };
}

/**
 * A tool that executes a {@link BaseNode} (e.g. a `Workflow` or a function node)
 * on behalf of an `LlmAgent`. This is the inverse of {@link ToolNode} (which
 * exposes a tool as a workflow node): here a node/workflow is exposed to a model
 * as a callable tool.
 *
 * The wrapped node MUST declare an `inputSchema` (the tool's parameter schema
 * is derived from it), unless it is a `FunctionNode`: a function node that
 * takes no input is declared with no parameters. When the model calls the tool,
 * the node runs with a {@link NodeContext} bridged from the tool's agent
 * context (sharing the invocation, session, and state); the node's structured
 * output becomes the tool result.
 *
 * A node that fails, or a model argument that fails the node's input schema,
 * becomes an error string as the tool result, so the model can retry or explain
 * rather than the invocation ending.
 *
 * Ported from `google/adk-python` `tools/_node_tool.py::NodeTool`.
 *
 * The tool is marked long-running so a node that pauses for input
 * (`RequestInput`) does not force a synthetic empty response.
 */
export class NodeTool extends BaseTool {
  /** Brand identifying this object as a {@link NodeTool} (see `isNodeTool`). */
  readonly [NODE_TOOL_SIGNATURE_SYMBOL] = true;

  readonly node: BaseNode;

  /**
   * Whether the model's arguments go to the node as-is. A scalar input schema
   * is advertised wrapped under `request`, so its value is unwrapped again on
   * the way in. A node with no input schema takes the arguments unchanged.
   */
  private readonly inputIsObject: boolean;

  constructor(node: BaseNode, name?: string, description?: string) {
    if (isBaseAgent(node)) {
      throw new Error(
        `Agent '${node.name}' cannot be wrapped as a NodeTool. Agents should ` +
          'be invoked as Sub-Agents instead.',
      );
    }
    // A function node with no input schema takes no input, which is a valid
    // tool with no parameters rather than a missing declaration.
    if (!node.inputSchema && !isFunctionNode(node)) {
      throw new Error(
        `Node '${node.name}' does not have an inputSchema defined. NodeTool ` +
          'requires an explicit input schema on the wrapped node.',
      );
    }
    super({
      name: name ?? node.name,
      description:
        description || node.description || `Executes the node: ${node.name}`,
      isLongRunning: true,
    });
    this.node = node;
    this.inputIsObject =
      !node.inputSchema || toJsonSchema(node.inputSchema)['type'] === 'object';
  }

  override _getDeclaration(): FunctionDeclaration {
    const declaration: FunctionDeclaration = {
      name: this.name,
      description: this.description,
    };
    const schema = this.node.inputSchema;
    if (schema) {
      // Narrow inline so `zodObjectToSchema` typechecks without a cast.
      if (isZodObject(schema)) {
        declaration.parameters = zodObjectToSchema(schema);
      } else {
        const json = toJsonSchema(schema);
        declaration.parametersJsonSchema = this.inputIsObject
          ? json
          : wrapScalarSchema(json);
      }
    }
    if (this.node.outputSchema) {
      declaration.responseJsonSchema = toJsonSchema(this.node.outputSchema);
    }
    return declaration;
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const schema = this.node.inputSchema;
    const nodeInput = this.inputIsObject ? args : args['request'];
    if (isZodSchema(schema)) {
      try {
        // Zod is the analogue of Python's pydantic branch: the model's
        // arguments are checked here so a bad call is reported to the model
        // instead of ending the invocation. The node still receives the
        // original value, because it parses its own input and a schema
        // carrying a non-idempotent `.transform()` rejects an already-parsed
        // one. A genai `Schema` is left to `validateInput` entirely.
        parseWithSchema(schema, nodeInput);
      } catch (e: unknown) {
        return `Error validating input for node: ${formatError(e)}`;
      }
    }

    const {nodeCtx, runId, overrideBranch} = this.prepareChildRun(toolContext);

    let child: NodeContext;
    try {
      child = await executeChildNode({
        parent: nodeCtx,
        node: this.node,
        input: nodeInput,
        options: {runId, overrideBranch},
      });
    } catch (e: unknown) {
      // A cancelled invocation, and a dynamic child's own failure, are terminal
      // for the whole run — reporting either as a tool result would let the
      // model carry on past it.
      if (isInvocationAbortedError(e) || isDynamicNodeFailError(e)) {
        throw e;
      }
      return `Error running node ${this.name}: ${formatError(e)}`;
    }

    if (child.interruptIds.length > 0) {
      // The node paused for input. Returning undefined leaves the (long-running)
      // tool call pending; the interrupt event has been surfaced separately so
      // the invocation can pause and resume. (Resume wiring is layered on top.)
      return undefined;
    }

    return child.output === undefined ? {result: null} : child.output;
  }

  /**
   * Builds the {@link NodeContext} the wrapped node runs under, bridged from
   * the agent's tool context. Node events are streamed into the invocation's
   * event queue so intermediate/interrupt events surface to the agent (and a
   * paused node can be resumed). Requires being invoked from an `LlmAgent`
   * tool-call step, which is what provides that queue and the function-call id.
   *
   * Every error raised here reports a misconfigured host rather than a failing
   * node, so each one throws instead of becoming a tool result the model reads.
   */
  private prepareChildRun(toolContext: Context): {
    nodeCtx: NodeContext;
    runId: string;
    overrideBranch: string;
  } {
    const ic = toolContext.invocationContext;

    // A paused node's interrupt event must reach the session, so an event queue
    // is required; without one the pause would be a silent dead end.
    const channel = ic.eventQueue;
    if (!channel) {
      throw new Error(
        `NodeTool '${this.name}' requires an invocation event queue; ` +
          'it must be invoked from an LlmAgent tool-call step.',
      );
    }

    // A stable, unique run id per tool call: reused across resume so the paused
    // run can be matched. (A shared fallback would collapse distinct calls.)
    const runId = toolContext.functionCallId;
    if (!runId) {
      throw new Error(
        `NodeTool '${this.name}' requires a function-call id; ` +
          'it must be invoked from an LlmAgent tool-call step.',
      );
    }

    if (ic.nodeToolDepth >= MAX_NODE_TOOL_DEPTH) {
      throw new Error(
        `NodeTool '${this.name}': node-tool nesting exceeded ` +
          `${MAX_NODE_TOOL_DEPTH} (possible node -> tool -> node recursion).`,
      );
    }
    // Run the node (and anything it reaches) at depth+1 so the guard above trips
    // on unbounded recursion; the clone carries the depth across agent runs.
    const childIc = ic.clone({nodeToolDepth: ic.nodeToolDepth + 1});

    const nodeCtx = new NodeContext({
      invocationContext: childIc,
      channel,
      // Empty so executeChildNode's path is a single segment (the node name),
      // not the node name doubled.
      nodePath: '',
      runId,
      resumeInputs: toolContext.resumeInputs,
    });

    const base = childIc.branch;
    const segment = `${this.name}@${runId}`;
    const overrideBranch = base ? `${base}.${segment}` : segment;

    return {nodeCtx, runId, overrideBranch};
  }
}

/**
 * Type guard for {@link NodeTool}. Matches on the brand rather than `instanceof`
 * so it stays correct across package copies (mirrors `isBaseTool`).
 */
export function isNodeTool(value: unknown): value is NodeTool {
  return (
    typeof value === 'object' &&
    value !== null &&
    NODE_TOOL_SIGNATURE_SYMBOL in value &&
    value[NODE_TOOL_SIGNATURE_SYMBOL] === true
  );
}
