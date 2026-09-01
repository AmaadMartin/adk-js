/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it} from 'vitest';

import type {
  StdioConnectionParams,
  StreamableHTTPConnectionParams,
} from '../../../src/tools/mcp/mcp_session_manager.js';
import {
  ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR,
  McpToolsetConfig,
  resolveConfigConnectionParams,
  setAllowConfigStdioServers,
} from '../../../src/tools/mcp/mcp_toolset_config.js';

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

describe('resolveConfigConnectionParams', () => {
  afterEach(() => {
    setAllowConfigStdioServers(undefined);
    setEnvOptIn(undefined);
  });

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
      'Exactly one of stdioConnectionParams, streamableHttpConnectionParams ' +
        'must be set.',
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

  it('refuses a stdio server declared under the remote transport field', () => {
    // The guard cannot read the field name alone: MCPSessionManager picks the
    // transport from `type`, so this config would spawn a local process.
    const hostile: McpToolsetConfig = JSON.parse(
      JSON.stringify({
        streamableHttpConnectionParams: {
          type: 'StdioConnectionParams',
          serverParams: {command: 'attacker-controlled-binary'},
        },
      }),
    );

    expect(() => resolveConfigConnectionParams(hostile)).toThrow(
      "streamableHttpConnectionParams must declare connection params of type 'StreamableHTTPConnectionParams'",
    );
  });

  it('refuses that config even when stdio servers are allowed', () => {
    setAllowConfigStdioServers(true);
    const mismatched: McpToolsetConfig = JSON.parse(
      JSON.stringify({
        streamableHttpConnectionParams: {
          type: 'StdioConnectionParams',
          serverParams: {command: 'attacker-controlled-binary'},
        },
      }),
    );

    expect(() => resolveConfigConnectionParams(mismatched)).toThrow(
      'must declare connection params of type',
    );
  });

  it('refuses a remote transport declared under the stdio field', () => {
    setAllowConfigStdioServers(true);
    const mismatched: McpToolsetConfig = JSON.parse(
      JSON.stringify({
        stdioConnectionParams: {
          type: 'StreamableHTTPConnectionParams',
          url: 'https://example.com/mcp',
        },
      }),
    );

    expect(() => resolveConfigConnectionParams(mismatched)).toThrow(
      "stdioConnectionParams must declare connection params of type 'StdioConnectionParams'",
    );
  });

  it('refuses params that carry no type at all', () => {
    const untyped: McpToolsetConfig = JSON.parse(
      JSON.stringify({
        streamableHttpConnectionParams: {url: 'https://example.com/mcp'},
      }),
    );

    expect(() => resolveConfigConnectionParams(untyped)).toThrow(
      'must declare connection params of type',
    );
  });

  it('leaves a remote transport unaffected by the guard', () => {
    setAllowConfigStdioServers(false);

    expect(
      resolveConfigConnectionParams({
        streamableHttpConnectionParams: httpParams,
      }),
    ).toBe(httpParams);
  });
});
