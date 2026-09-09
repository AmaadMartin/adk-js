/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR,
  McpToolsetConfig,
  resolveConfigConnectionParams,
  StdioConnectionParams,
  StreamableHTTPConnectionParams,
} from '@google/adk';

const stdioConnectionParams: StdioConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test-server'},
};

const streamableHttpConnectionParams: StreamableHTTPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'https://example.test/mcp',
};

describe('resolveConfigConnectionParams', () => {
  const originalEnvValue = process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR];

  beforeEach(() => {
    delete process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR];
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR];
    } else {
      process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR] = originalEnvValue;
    }
  });

  describe('exactly-one validation', () => {
    it('rejects a config that declares no connection param', () => {
      expect(() => resolveConfigConnectionParams({})).toThrow(
        /Exactly one of stdioConnectionParams, streamableHttpConnectionParams/,
      );
    });

    it('rejects a config that declares both connection params', () => {
      const config: McpToolsetConfig = {
        stdioConnectionParams,
        streamableHttpConnectionParams,
      };

      expect(() => resolveConfigConnectionParams(config)).toThrow(
        /Exactly one of/,
      );
    });

    it('treats an explicit null the way JSON means it: absent', () => {
      const config = JSON.parse(
        '{"stdioConnectionParams": null}',
      ) as McpToolsetConfig;

      expect(() => resolveConfigConnectionParams(config)).toThrow(
        /Exactly one of/,
      );
    });
  });

  describe('remote transport', () => {
    it('returns the streamable HTTP params and never gates them', () => {
      const resolved = resolveConfigConnectionParams({
        streamableHttpConnectionParams,
      });

      expect(resolved).toBe(streamableHttpConnectionParams);
    });
  });

  describe('stdio gating', () => {
    it('rejects a stdio server when the application has not opted in', () => {
      const resolve = () =>
        resolveConfigConnectionParams({stdioConnectionParams});

      expect(resolve).toThrow(/not allowed in agent configs/);
      expect(resolve).toThrow(/ADK_ALLOW_CONFIG_STDIO_MCP_SERVERS/);
    });

    it('allows a stdio server when the environment variable is 1', () => {
      process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR] = '1';

      expect(resolveConfigConnectionParams({stdioConnectionParams})).toBe(
        stdioConnectionParams,
      );
    });

    it('allows a stdio server when the environment variable is true', () => {
      process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR] = 'true';

      expect(resolveConfigConnectionParams({stdioConnectionParams})).toBe(
        stdioConnectionParams,
      );
    });

    it('rejects a stdio server when the environment variable is 0', () => {
      process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR] = '0';

      expect(() =>
        resolveConfigConnectionParams({stdioConnectionParams}),
      ).toThrow(/not allowed in agent configs/);
    });
  });
});
