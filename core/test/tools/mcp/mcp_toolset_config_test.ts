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
  resolveConfigConnectionParams,
  setAllowConfigStdioServers,
} from '../../../src/tools/mcp/mcp_toolset_config.js';

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}));

const stdioParams: StdioConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'npx', args: ['-y', 'some-mcp-server']},
};

const httpParams: StreamableHTTPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'https://example.com/mcp',
};

/** Sets the opt-in environment variable for one test. */
function setEnvOptIn(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR];
    return;
  }
  process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR] = value;
}

/** Clears both opt-in channels between tests. */
function clearOptIn(): void {
  vi.unstubAllEnvs();
  setEnvOptIn(undefined);
  setAllowConfigStdioServers(undefined);
}

describe('resolveConfigConnectionParams', () => {
  afterEach(clearOptIn);

  it('returns the streamable HTTP params when only they are set', () => {
    expect(
      resolveConfigConnectionParams({
        streamableHttpConnectionParams: httpParams,
      }),
    ).toBe(httpParams);
  });

  it('returns the stdio params once the host opts in', () => {
    setAllowConfigStdioServers(true);

    expect(
      resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
    ).toBe(stdioParams);
  });

  it('rejects a config that declares no connection params', () => {
    expect(() => resolveConfigConnectionParams({})).toThrow(
      'Exactly one of stdioServerParams, stdioConnectionParams, ' +
        'streamableHttpConnectionParams must be set.',
    );
  });

  it('rejects a config that declares two connection params', () => {
    setAllowConfigStdioServers(true);

    expect(() =>
      resolveConfigConnectionParams({
        stdioConnectionParams: stdioParams,
        streamableHttpConnectionParams: httpParams,
      }),
    ).toThrow('Exactly one of');
  });

  it('counts the transport fields before it applies the stdio guard', () => {
    expect(() =>
      resolveConfigConnectionParams({
        stdioConnectionParams: stdioParams,
        streamableHttpConnectionParams: httpParams,
      }),
    ).toThrow('Exactly one of');
  });

  it('treats a null transport field as absent', () => {
    // Parsed rather than written out, because a null is what a config file
    // delivers for a field it leaves blank, and the type forbids writing one.
    const config: McpToolsetConfig = JSON.parse(
      JSON.stringify({
        stdioConnectionParams: null,
        streamableHttpConnectionParams: httpParams,
      }),
    );

    expect(resolveConfigConnectionParams(config)).toEqual(httpParams);
  });

  it('does not accept a non-transport field in place of one', () => {
    expect(() =>
      resolveConfigConnectionParams({toolFilter: ['read_file'], prefix: 'fs'}),
    ).toThrow('Exactly one of');
  });

  it('refuses a stdio server with no opt-in', () => {
    expect(() =>
      resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
    ).toThrow('not allowed in agent configs');
  });

  it('names the environment variable in the refusal', () => {
    expect(() =>
      resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
    ).toThrow(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR);
  });

  it.each(['1', 'true', 'TRUE'])(
    'accepts a stdio server when the variable is %s',
    (value) => {
      setEnvOptIn(value);

      expect(
        resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
      ).toBe(stdioParams);
    },
  );

  it('still refuses a stdio server when the variable is 0', () => {
    setEnvOptIn('0');

    expect(() =>
      resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
    ).toThrow('not allowed in agent configs');
  });

  it('lets the in-process override refuse what the variable allows', () => {
    setEnvOptIn('1');
    setAllowConfigStdioServers(false);

    expect(() =>
      resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
    ).toThrow('not allowed in agent configs');
  });

  it('defers to the variable again once the override is cleared', () => {
    setEnvOptIn('1');
    setAllowConfigStdioServers(false);
    setAllowConfigStdioServers(undefined);

    expect(
      resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
    ).toBe(stdioParams);
  });

  it('leaves a remote transport unaffected by the guard', () => {
    setAllowConfigStdioServers(false);

    expect(
      resolveConfigConnectionParams({
        streamableHttpConnectionParams: httpParams,
      }),
    ).toBe(httpParams);
  });

  describe('exactly one transport', () => {
    const rejected: Array<[string, McpToolsetConfig]> = [
      ['no transport at all', {}],
      ['only non-transport fields', {toolFilter: ['a'], prefix: 'p'}],
      [
        'two transports',
        {
          stdioConnectionParams: stdioParams,
          streamableHttpConnectionParams: httpParams,
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
        expect(() => resolveConfigConnectionParams(config)).toThrow(
          'Exactly one of stdioServerParams, stdioConnectionParams, streamableHttpConnectionParams must be set.',
        );
      });
    }

    it('accepts a lone remote transport', () => {
      expect(
        resolveConfigConnectionParams({
          streamableHttpConnectionParams: httpParams,
        }),
      ).toBe(httpParams);
    });

    it('wraps bare stdio server params into connection params', () => {
      vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, '1');

      expect(
        resolveConfigConnectionParams({stdioServerParams: {command: 'npx'}}),
      ).toEqual({
        type: 'StdioConnectionParams',
        serverParams: {command: 'npx'},
      });
    });

    it('accepts lone stdio connection params', () => {
      vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, '1');

      expect(
        resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
      ).toBe(stdioParams);
    });
  });

  describe('stdio guard', () => {
    it('refuses a stdio server by default and says how to allow it', () => {
      expect(() =>
        resolveConfigConnectionParams({stdioServerParams: {command: 'npx'}}),
      ).toThrow(
        expect.objectContaining({
          message: expect.stringContaining('not allowed in agent configs'),
        }),
      );
      expect(() =>
        resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
      ).toThrow(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR);
    });

    it('leaves a remote transport alone', () => {
      expect(() =>
        resolveConfigConnectionParams({
          streamableHttpConnectionParams: httpParams,
        }),
      ).not.toThrow();
    });

    for (const value of ['1', 'true', 'TRUE', 'True']) {
      it(`allows stdio when the env var is ${value}`, () => {
        vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, value);

        expect(() =>
          resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
        ).not.toThrow();
      });
    }

    for (const value of ['0', 'false', '', 'yes']) {
      it(`keeps stdio refused when the env var is "${value}"`, () => {
        vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, value);

        expect(() =>
          resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
        ).toThrow('not allowed in agent configs');
      });
    }

    it('is refused when the env var is unset', () => {
      expect(() =>
        resolveConfigConnectionParams({stdioConnectionParams: stdioParams}),
      ).toThrow('not allowed in agent configs');
    });
  });
});

describe('MCPToolset.fromConfig', () => {
  afterEach(clearOptIn);

  it('carries the transport, filter and prefix into the toolset', async () => {
    const toolset = await MCPToolset.fromConfig({
      streamableHttpConnectionParams: httpParams,
      toolFilter: ['read_file'],
      prefix: 'srv',
    });

    expect(toolset.toolFilter).toEqual(['read_file']);
    expect(toolset.prefix).toBe('srv');
  });

  it('defaults the filter to "expose everything" and leaves the prefix unset', async () => {
    const toolset = await MCPToolset.fromConfig({
      streamableHttpConnectionParams: httpParams,
    });

    expect(toolset.toolFilter).toEqual([]);
    expect(toolset.prefix).toBeUndefined();
  });

  it('refuses a config-declared stdio server', async () => {
    await expect(
      MCPToolset.fromConfig({stdioServerParams: {command: 'npx'}}),
    ).rejects.toThrow('not allowed in agent configs');
  });

  it('builds a stdio toolset once the operator opts in', async () => {
    vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, '1');

    const toolset = await MCPToolset.fromConfig({
      stdioServerParams: {command: 'npx'},
    });

    expect(toolset.connectionParams).toEqual({
      type: 'StdioConnectionParams',
      serverParams: {command: 'npx'},
    });
  });
});
