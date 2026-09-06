/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isRemoteMcpServer, RemoteMcpServer} from '@google/adk';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const SOURCE_PATH = fileURLToPath(
  new URL('../../src/tools/remote_mcp_server.ts', import.meta.url),
);

describe('RemoteMcpServer leaf-module invariant', () => {
  /**
   * Ports `test_tools_import_first_has_no_cycle` from
   * google/adk-python `tests/unittests/agents/test_managed_agent.py`. Python
   * spawns an interpreter to prove the import order; TypeScript resolves
   * modules at build time, so the invariant is checked at its source instead.
   *
   * `agents/` imports `tools/`, so a runtime import back into `agents/` from
   * this module closes a cycle. A type-only import is erased and is safe.
   */
  it('imports nothing from agents/ at runtime', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const agentImports = source
      .split('\n')
      .filter((line) => line.includes("from '../agents/"));

    expect(agentImports.length).toBeGreaterThan(0);
    for (const line of agentImports) {
      expect(line).toMatch(/^import type /);
    }
  });
});

describe('isRemoteMcpServer', () => {
  it('accepts a remote MCP server', () => {
    const server = new RemoteMcpServer({url: 'https://example.test/mcp'});

    expect(isRemoteMcpServer(server)).toBe(true);
  });

  it('rejects a value that is not one', () => {
    expect(isRemoteMcpServer({url: 'https://example.test/mcp'})).toBe(false);
    expect(isRemoteMcpServer(undefined)).toBe(false);
  });
});
