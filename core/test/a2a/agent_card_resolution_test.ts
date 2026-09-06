/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {isAgentCardResolutionError} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {resolveAgentCard} from '../../src/a2a/agent_card.js';

const CARD: AgentCard = {
  name: 'peer',
  description: 'a peer',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: 'https://peer.example.com/a2a',
  capabilities: {streaming: true},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [],
};

const tempDirs: string[] = [];

async function writeCardFile(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-card-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'card.json');
  await fs.writeFile(file, contents, 'utf-8');
  return file;
}

/** A `fetch` that records its calls and always answers with `CARD`. */
function recordingFetch(): {
  fetchImpl: typeof fetch;
  calls: Array<{url: string; init?: Parameters<typeof fetch>[1]}>;
} {
  const calls: Array<{url: string; init?: Parameters<typeof fetch>[1]}> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({url: String(input), init});
    return new Response(JSON.stringify(CARD), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };
  return {fetchImpl, calls};
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, {recursive: true, force: true})),
  );
});

describe('resolveAgentCard', () => {
  it('returns a card object unchanged', async () => {
    await expect(resolveAgentCard(CARD)).resolves.toBe(CARD);
  });

  it('reads a card from a local file', async () => {
    const file = await writeCardFile(JSON.stringify(CARD));
    await expect(resolveAgentCard(file)).resolves.toEqual(CARD);
  });

  it('reports a missing card file by path', async () => {
    await expect(
      resolveAgentCard('/nonexistent/adk/card.json'),
    ).rejects.toThrow('Agent card file not found: /nonexistent/adk/card.json');
  });

  it('reports invalid JSON in a card file', async () => {
    const file = await writeCardFile('{ not json');
    await expect(resolveAgentCard(file)).rejects.toThrow(
      `Invalid JSON in agent card file ${file}`,
    );
  });

  it('raises AgentCardResolutionError for a file failure', async () => {
    const file = await writeCardFile('{ not json');
    await resolveAgentCard(file).then(
      () => expect.fail('resolveAgentCard should have rejected'),
      (err: unknown) => expect(isAgentCardResolutionError(err)).toBe(true),
    );
  });

  it('wraps a failed URL fetch with the source URL', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connection refused');
    };
    await expect(
      resolveAgentCard('https://peer.example.com', {fetchImpl}),
    ).rejects.toThrow(
      /Failed to resolve AgentCard from URL https:\/\/peer\.example\.com: .*connection refused/,
    );
  });

  it('sends the configured headers on the card fetch', async () => {
    const {fetchImpl, calls} = recordingFetch();
    await resolveAgentCard('https://peer.example.com', {
      fetchImpl,
      headers: {'X-API-Key': 'key-1'},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.headers).toMatchObject({'X-API-Key': 'key-1'});
  });

  it('uses the plain fetch when no headers or timeout are configured', async () => {
    const {fetchImpl, calls} = recordingFetch();
    await resolveAgentCard('https://peer.example.com', {fetchImpl});
    expect(calls[0].init?.signal).toBeUndefined();
  });

  it('attaches an abort signal when a timeout is configured', async () => {
    const {fetchImpl, calls} = recordingFetch();
    await resolveAgentCard('https://peer.example.com', {
      fetchImpl,
      timeoutMs: 5_000,
    });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a hung card fetch once the timeout elapses', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    await expect(
      resolveAgentCard('https://peer.example.com', {fetchImpl, timeoutMs: 10}),
    ).rejects.toThrow(/Failed to resolve AgentCard from URL/);
  });
});
