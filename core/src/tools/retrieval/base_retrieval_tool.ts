/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionDeclaration} from '@google/genai';
import {Type} from '@google/genai';

import {BaseTool} from '../base_tool.js';

/**
 * The base class for a tool that retrieves data for a natural-language query.
 *
 * It contributes the model-facing declaration that every retrieval tool shares:
 * a single optional string parameter `query`. A subclass supplies `runAsync`
 * and nothing else is required.
 *
 * A retrieval that matches nothing is a normal outcome. Return a message that
 * says so, so the model can act on it and continue the turn. Do not throw.
 */
export abstract class BaseRetrievalTool extends BaseTool {
  override _getDeclaration(): FunctionDeclaration {
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
