/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import type {OpenAPIV3} from 'openapi-types';
import type {ReadonlyContext} from '../../agents/readonly_context.js';
import type {AuthCredential} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import type {BaseTool} from '../base_tool.js';
import type {ToolPredicate} from '../base_toolset.js';
import {BaseToolset} from '../base_toolset.js';
import {OpenApiSpecParser} from './openapi_spec_parser/openapi_spec_parser.js';
import type {RestApiTool} from './rest_api_tool.js';
import {createRestApiTool} from './rest_api_tool.js';

@experimental
export class OpenAPIToolset extends BaseToolset {
  private tools: RestApiTool[] = [];

  constructor(
    options: {
      specDict?: OpenAPIV3.Document;
      specStr?: string;
      specType?: 'json' | 'yaml';
      toolFilter?: ToolPredicate | string[];
      prefix?: string;
      preservePropertyNames?: boolean;
      authScheme?: OpenAPIV3.SecuritySchemeObject;
      authCredential?: AuthCredential;
      credentialKey?: string;
      headerProvider?: (context: ReadonlyContext) => Record<string, string>;
    } = {},
  ) {
    super(options.toolFilter || [], options.prefix);

    let spec = options.specDict;
    if (!spec && options.specStr) {
      if (
        options.specType === 'yaml' ||
        (!options.specType && options.specStr.trim().startsWith('---'))
      ) {
        spec = yaml.load(options.specStr) as OpenAPIV3.Document;
      } else {
        spec = JSON.parse(options.specStr) as OpenAPIV3.Document;
      }
    }

    if (!spec) {
      throw new Error('Either specDict or specStr must be provided.');
    }

    const parser = new OpenApiSpecParser({
      preservePropertyNames: options.preservePropertyNames,
    });
    const parsedOperations = parser.parse(spec);

    for (const op of parsedOperations) {
      let toolName = op.name;
      if (this.prefix) {
        toolName = `${this.prefix}_${toolName}`;
      }

      const tool = createRestApiTool(
        {
          name: toolName,
          description: op.description,
          endpoint: op.endpoint,
          operation: op.operation,
          authScheme: op.authScheme,
        },
        {
          preservePropertyNames: options.preservePropertyNames,
          headerProvider: options.headerProvider,
          credentialKey: options.credentialKey,
        },
      );

      this.tools.push(tool);
    }

    // Apply global auth overrides if provided
    if (options.authScheme || options.authCredential) {
      for (const tool of this.tools) {
        if (options.authScheme) tool.configureAuthScheme(options.authScheme);
        if (options.authCredential)
          tool.configureAuthCredential(options.authCredential);
      }
    }
  }

  @experimental
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools.filter((tool) => {
      if (Array.isArray(this.toolFilter) && this.toolFilter.length > 0) {
        return (this.toolFilter as string[]).includes(tool.name);
      }
      if (context) {
        return this.isToolSelected(tool, context);
      }
      return true;
    });
  }

  @experimental
  override async close(): Promise<void> {
    // No persistent connections to close in this implementation
    return Promise.resolve();
  }
}
