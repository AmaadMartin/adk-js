/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Edges the adk-python reference suite does not reach. The reference is
 * adk-python `main`, `src/google/adk/tools/_remote_mcp_server.py`.
 */

import {
  InputValidationError,
  RemoteMcpServer,
  RemoteMcpServerOptions,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {buildMcpServerParam} from '../../src/models/interactions_utils.js';

/**
 * Models the caller the runtime check exists for: options read from a
 * configuration document, which TypeScript never sees.
 */
function parseOptions(json: string): RemoteMcpServerOptions {
  return JSON.parse(json);
}

describe('RemoteMcpServer edge cases', () => {
  it('emits an empty allowed_tools list and an empty name', () => {
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      name: '',
      allowedTools: [],
    });

    expect(buildMcpServerParam(server, {})).toEqual({
      type: 'mcp_server',
      url: 'https://x/mcp',
      name: '',
      allowed_tools: [{tools: []}],
    });
  });

  it('does not alias the spec allowedTools array', () => {
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      allowedTools: ['a'],
    });

    const param = buildMcpServerParam(server, {});
    expect(param.allowed_tools).toEqual([{tools: ['a']}]);
    param.allowed_tools?.[0].tools?.push('b');

    expect(server.allowedTools).toEqual(['a']);
  });

  it('refuses a headerProvider that is not a function', () => {
    const options = parseOptions(
      '{"url": "https://x/mcp", "headerProvider": "not-a-function"}',
    );

    expect(() => new RemoteMcpServer(options)).toThrow(InputValidationError);
    expect(() => new RemoteMcpServer(options)).toThrow(/headerProvider/);
  });

  it('names the unknown key without echoing a header value', () => {
    const options = parseOptions(
      '{"url": "https://x/mcp",' +
        ' "headers": {"Authorization": "Bearer super-secret"},' +
        ' "bogus": "nope"}',
    );

    expect(() => new RemoteMcpServer(options)).toThrow(/bogus/);
    expect(() => new RemoteMcpServer(options)).not.toThrow(
      /super-secret|Bearer/,
    );
  });
});
