/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mirrors `TestMcpToolsetConfig` and the `from_config` cases of
 * `TestMcpToolset` in adk-python's
 * `tests/unittests/tools/mcp_tool/test_mcp_toolset.py`.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

import type {
  StdioConnectionParams,
  StreamableHTTPConnectionParams,
} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';
import {
  ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR,
  McpToolsetConfig,
  resolveMcpConnectionParams,
} from '../../../src/tools/mcp/mcp_toolset_config.js';

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}));

const remoteParams: StreamableHTTPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'https://example.com/mcp',
};

const stdioParams: StdioConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'npx', args: ['-y', 'some-server']},
};

describe('resolveMcpConnectionParams', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('exactly one transport', () => {
    const rejected: Array<[string, McpToolsetConfig]> = [
      ['no transport at all', {}],
      ['only non-transport fields', {toolFilter: ['a'], toolNamePrefix: 'p'}],
      [
        'two transports',
        {
          stdioConnectionParams: stdioParams,
          streamableHttpConnectionParams: remoteParams,
        },
      ],
      [
        'both stdio spellings',
        {
          stdioServerParams: {command: 'npx'},
          stdioConnectionParams: stdioParams,
        },
      ],
    ];

    for (const [label, config] of rejected) {
      it(`rejects ${label}`, () => {
        expect(() => resolveMcpConnectionParams(config)).toThrow(
          'Exactly one of stdioServerParams, stdioConnectionParams, streamableHttpConnectionParams must be set.',
        );
      });
    }

    it('accepts a lone remote transport', () => {
      expect(
        resolveMcpConnectionParams({
          streamableHttpConnectionParams: remoteParams,
        }),
      ).toBe(remoteParams);
    });

    it('wraps bare stdio server params into connection params', () => {
      vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, '1');

      expect(
        resolveMcpConnectionParams({stdioServerParams: {command: 'npx'}}),
      ).toEqual({
        type: 'StdioConnectionParams',
        serverParams: {command: 'npx'},
      });
    });

    it('accepts lone stdio connection params', () => {
      vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, '1');

      expect(
        resolveMcpConnectionParams({stdioConnectionParams: stdioParams}),
      ).toBe(stdioParams);
    });
  });

  describe('stdio guard', () => {
    it('refuses a stdio server by default and says how to allow it', () => {
      expect(() =>
        resolveMcpConnectionParams({stdioServerParams: {command: 'npx'}}),
      ).toThrow(
        expect.objectContaining({
          message: expect.stringContaining('not allowed in agent configs'),
        }),
      );
      expect(() =>
        resolveMcpConnectionParams({stdioConnectionParams: stdioParams}),
      ).toThrow(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR);
    });

    it('leaves a remote transport alone', () => {
      expect(() =>
        resolveMcpConnectionParams({
          streamableHttpConnectionParams: remoteParams,
        }),
      ).not.toThrow();
    });

    for (const value of ['1', 'true', 'TRUE', 'True']) {
      it(`allows stdio when the env var is ${value}`, () => {
        vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, value);

        expect(() =>
          resolveMcpConnectionParams({stdioConnectionParams: stdioParams}),
        ).not.toThrow();
      });
    }

    for (const value of ['0', 'false', '', 'yes']) {
      it(`keeps stdio refused when the env var is "${value}"`, () => {
        vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, value);

        expect(() =>
          resolveMcpConnectionParams({stdioConnectionParams: stdioParams}),
        ).toThrow('not allowed in agent configs');
      });
    }

    it('is refused when the env var is unset', () => {
      expect(() =>
        resolveMcpConnectionParams({stdioConnectionParams: stdioParams}),
      ).toThrow('not allowed in agent configs');
    });
  });
});

describe('MCPToolset.fromConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('carries the transport, filter and prefix into the toolset', () => {
    const toolset = MCPToolset.fromConfig({
      streamableHttpConnectionParams: remoteParams,
      toolFilter: ['read_file'],
      toolNamePrefix: 'srv',
    });

    expect(toolset.toolFilter).toEqual(['read_file']);
    expect(toolset.prefix).toBe('srv');
  });

  it('defaults the filter to "expose everything" and leaves the prefix unset', () => {
    const toolset = MCPToolset.fromConfig({
      streamableHttpConnectionParams: remoteParams,
    });

    expect(toolset.toolFilter).toEqual([]);
    expect(toolset.prefix).toBeUndefined();
  });

  it('refuses a config-declared stdio server', () => {
    expect(() =>
      MCPToolset.fromConfig({stdioServerParams: {command: 'npx'}}),
    ).toThrow('not allowed in agent configs');
  });

  it('builds a stdio toolset once the operator opts in', () => {
    vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, '1');

    expect(() =>
      MCPToolset.fromConfig({stdioServerParams: {command: 'npx'}}),
    ).not.toThrow();
  });
});
