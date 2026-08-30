/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionDeclaration, Schema} from '@google/genai';
import {Type} from '@google/genai';

import type {RunAsyncToolRequest} from '../../tools/base_tool.js';
import {BaseTool} from '../../tools/base_tool.js';
import {
  isZodObject,
  zodObjectToSchema,
} from '../../utils/simple_zod_to_json.js';
import type {BaseNode} from '../base_node.js';
import {runNodeFromToolContext} from '../run_node_from_tool.js';

/**
 * A unique symbol branding {@link NodeTool} instances (see `isNodeTool`).
 */
const NODE_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.workflow.nodeTool');

/**
 * A tool that executes a {@link BaseNode} (e.g. a `Workflow` or a function node)
 * on behalf of an `LlmAgent`. This is the inverse of {@link ToolNode} (which
 * exposes a tool as a workflow node): here a node/workflow is exposed to a model
 * as a callable tool.
 *
 * The wrapped node MUST declare an `inputSchema` (the tool's parameter schema is
 * derived from it). When the model calls the tool, the node runs with a
 * {@link NodeContext} bridged from the tool's agent context (sharing the
 * invocation, session, and state); the node's structured output becomes the
 * tool result.
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

  constructor(node: BaseNode, name?: string, description?: string) {
    if (!node.inputSchema) {
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
  }

  override _getDeclaration(): FunctionDeclaration {
    const schema = this.node.inputSchema;
    let parameters: Schema;
    // Narrow inline so `zodObjectToSchema` typechecks without a cast.
    if (schema && isZodObject(schema)) {
      parameters = zodObjectToSchema(schema);
    } else {
      // The GenAI API requires object-typed parameters; wrap a scalar schema
      // under a single `request` property.
      parameters = {
        type: Type.OBJECT,
        properties: {request: {type: Type.STRING}},
        required: ['request'],
      };
    }
    return {name: this.name, description: this.description, parameters};
  }

  /** Whether the node's input schema is a (Zod) object rather than a scalar. */
  private get inputIsObject(): boolean {
    return isZodObject(this.node.inputSchema);
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const nodeInput = this.inputIsObject ? args : args['request'];

    const child = await runNodeFromToolContext({
      toolContext,
      node: this.node,
      input: nodeInput,
      toolName: this.name,
    });

    if (child.interruptIds.length > 0) {
      // The node paused for input. Returning undefined leaves the (long-running)
      // tool call pending; the interrupt event has been surfaced separately so
      // the invocation can pause and resume. (Resume wiring is layered on top.)
      return undefined;
    }

    return child.output === undefined ? {result: null} : child.output;
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
