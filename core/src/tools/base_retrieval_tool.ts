/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {BaseTool} from './base_tool.js';

/**
 * A unique symbol to identify ADK retrieval tool classes.
 * Defined once and shared by all BaseRetrievalTool instances.
 */
const BASE_RETRIEVAL_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.baseRetrievalTool',
);

/**
 * Type guard to check if an object is an instance of BaseRetrievalTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseRetrievalTool, false
 *     otherwise.
 */
export function isBaseRetrievalTool(obj: unknown): obj is BaseRetrievalTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_RETRIEVAL_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[BASE_RETRIEVAL_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * The base class for a tool that retrieves data for a natural-language query.
 *
 * It contributes the model-facing declaration that every retrieval tool shares:
 * a single optional string parameter `query`. A subclass supplies `runAsync`
 * and nothing else is required.
 *
 * A retrieval that matches nothing is a normal outcome. Return a message that
 * says so, so the model can act on it and continue the turn. Do not throw.
 *
 * The model populates `args['query']`, so it is untrusted. A subclass must
 * validate it before it reaches an index, a filesystem, or a network call.
 */
export abstract class BaseRetrievalTool extends BaseTool {
  /** A unique symbol to identify ADK retrieval tool class. */
  readonly [BASE_RETRIEVAL_TOOL_SIGNATURE_SYMBOL] = true;

  /**
   * The `JSON_SCHEMA_FOR_FUNC_DECL` feature selects the declaration shape, and
   * is read on every call so a host can toggle it without rebuilding the tool.
   */
  override _getDeclaration(): FunctionDeclaration {
    if (isFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL)) {
      return {
        name: this.name,
        description: this.description,
        parametersJsonSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The query to retrieve.',
            },
          },
        },
      };
    }
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'The query to retrieve.',
          },
        },
      },
    };
  }
}
