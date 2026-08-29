/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPSessionManager, MCPTool} from '@google/adk';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it} from 'vitest';

/**
 * A session manager none of these tests connect through: every accessor under
 * test reads the tool declaration only.
 */
const SESSION_MANAGER = new MCPSessionManager({
  type: 'StdioConnectionParams',
  serverParams: {command: 'unused'},
});

/** Builds a tool declaration carrying the given MCP `_meta` block. */
function toolWithMeta(meta?: Record<string, unknown>): Tool {
  return {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {type: 'object', properties: {}},
    _meta: meta,
  };
}

describe('MCPTool MCP-App metadata', () => {
  describe('rawMcpTool', () => {
    it('returns the declaration as given, including undeclared fields', () => {
      const declaration = {
        name: 'raw-tool',
        inputSchema: {type: 'object' as const, properties: {}},
        vendorField: 'kept',
      };

      const tool = new MCPTool(declaration, SESSION_MANAGER);

      expect(tool.rawMcpTool).toBe(declaration);
      expect(tool.rawMcpTool).toHaveProperty('vendorField', 'kept');
    });
  });

  describe('mcpAppResourceUri', () => {
    it('reads the nested _meta.ui.resourceUri form', () => {
      const tool = new MCPTool(
        toolWithMeta({ui: {resourceUri: 'ui://test-resource'}}),
        SESSION_MANAGER,
      );

      expect(tool.mcpAppResourceUri).toBe('ui://test-resource');
    });

    it('reads the deprecated flat ui/resourceUri form', () => {
      const tool = new MCPTool(
        toolWithMeta({'ui/resourceUri': 'ui://test-resource-flat'}),
        SESSION_MANAGER,
      );

      expect(tool.mcpAppResourceUri).toBe('ui://test-resource-flat');
    });

    it('prefers the nested form over the flat form', () => {
      const tool = new MCPTool(
        toolWithMeta({
          ui: {resourceUri: 'ui://nested'},
          'ui/resourceUri': 'ui://flat',
        }),
        SESSION_MANAGER,
      );

      expect(tool.mcpAppResourceUri).toBe('ui://nested');
    });

    it('falls back to the flat form when the nested form is not a ui:// URI', () => {
      const tool = new MCPTool(
        toolWithMeta({
          ui: {resourceUri: 'https://nested'},
          'ui/resourceUri': 'ui://flat',
        }),
        SESSION_MANAGER,
      );

      expect(tool.mcpAppResourceUri).toBe('ui://flat');
    });

    it('is undefined when the tool declares no _meta', () => {
      const tool = new MCPTool(toolWithMeta(), SESSION_MANAGER);

      expect(tool.mcpAppResourceUri).toBeUndefined();
    });

    it('is undefined when the URI carries another scheme', () => {
      const tool = new MCPTool(
        toolWithMeta({ui: {resourceUri: 'http://invalid'}}),
        SESSION_MANAGER,
      );

      expect(tool.mcpAppResourceUri).toBeUndefined();
    });

    it('is undefined when the URI is not a string', () => {
      const tool = new MCPTool(
        toolWithMeta({ui: {resourceUri: 42}, 'ui/resourceUri': 42}),
        SESSION_MANAGER,
      );

      expect(tool.mcpAppResourceUri).toBeUndefined();
    });
  });
});
