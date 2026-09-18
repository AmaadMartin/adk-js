/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenApiSpecParser} from './openapi_spec_parser/openapi_spec_parser.js';
import {createRestApiTool, RestApiTool} from './rest_api_tool.js';

@experimental
export class OpenAPIToolset extends BaseToolset {
  private tools: RestApiTool[] = [];

  constructor(
    options: {
      specDict?: OpenAPIV3.Document;
      spec_dict?: OpenAPIV3.Document;
      specStr?: string;
      spec_str?: string;
      specType?: 'json' | 'yaml' | string;
      spec_str_type?: 'json' | 'yaml' | string;
      toolFilter?: ToolPredicate | string[];
      prefix?: string;
      preservePropertyNames?: boolean;
      authScheme?: OpenAPIV3.SecuritySchemeObject;
      auth_scheme?: OpenAPIV3.SecuritySchemeObject;
      authCredential?: AuthCredential;
      auth_credential?: AuthCredential;
      credentialKey?: string;
      headerProvider?: (context: ReadonlyContext) => Record<string, string>;
    } = {},
  ) {
    super(options.toolFilter || [], options.prefix);

    const specDict = options.specDict ?? options.spec_dict;
    const specStr = options.specStr ?? options.spec_str;
    const specType = options.specType ?? options.spec_str_type;
    const authScheme = options.authScheme ?? options.auth_scheme;
    const authCredential = options.authCredential ?? options.auth_credential;

    let spec = specDict;
    if (!spec && specStr) {
      if (specType && specType !== 'json' && specType !== 'yaml') {
        throw new Error(`Unsupported spec type: ${specType}`);
      }
      if (
        specType === 'yaml' ||
        (!specType && specStr.trim().startsWith('---'))
      ) {
        spec = yaml.load(specStr) as OpenAPIV3.Document;
      } else {
        spec = JSON.parse(specStr) as OpenAPIV3.Document;
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
    if (authScheme || authCredential) {
      for (const tool of this.tools) {
        if (authScheme) tool.configureAuthScheme(authScheme);
        if (authCredential) tool.configureAuthCredential(authCredential);
      }
    }
  }

  /**
   * Retrieves a specific RestApiTool by its name.
   */
  @experimental
  getTool(toolName: string): RestApiTool | undefined {
    return this.tools.find((t) => t.name === toolName);
  }

  /**
   * Snake_case alias for {@link getTool}.
   */
  @experimental
  get_tool(toolName: string): RestApiTool | undefined {
    return this.getTool(toolName);
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

  /**
   * Synchronous/compatible helper for retrieving all parsed RestApiTool instances.
   */
  @experimental
  get_tools(): RestApiTool[] {
    return [...this.tools];
  }

  @experimental
  override async close(): Promise<void> {
    // No persistent connections to close in this implementation
    return Promise.resolve();
  }
}
