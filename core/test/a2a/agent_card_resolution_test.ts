/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {
  adoptedCardDescription,
  AGENT_CARD_PATH,
  isAgentCardResolutionError,
  QUOTED_CONTENT_BEGIN,
  QUOTED_CONTENT_END,
  resolveAgentCard,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

const CARD: AgentCard = {
  name: 'peer',
  description: 'a peer',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: 'https://peer.example.com/a2a',
  skills: [],
  capabilities: {},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
};

const tempDirs: string[] = [];

async function writeCardFile(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-card-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'agent-card.json');
  await fs.writeFile(file, contents, 'utf-8');
  return file;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, {recursive: true, force: true})),
  );
});

describe('resolveAgentCard', () => {
  it('returns a card supplied directly', async () => {
    await expect(resolveAgentCard(CARD)).resolves.toBe(CARD);
  });

  it('fetches the well-known card path under the url', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return jsonResponse(CARD);
    };

    const card = await resolveAgentCard('https://peer.example.com', {
      fetchImpl,
    });

    expect(card.name).toBe('peer');
    expect(seen).toEqual([
      `https://peer.example.com/${AGENT_CARD_PATH.replace(/^\//, '')}`,
    ]);
  });

  it('sends the supplied headers on the card request', async () => {
    let sent: Headers | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent = new Headers(init?.headers);
      return jsonResponse(CARD);
    };

    await resolveAgentCard('https://peer.example.com', {
      headers: {Authorization: 'Bearer tok'},
      fetchImpl,
    });

    expect(sent?.get('authorization')).toBe('Bearer tok');
  });

  it('sends no headers when the caller supplied none', async () => {
    let sent: HeadersInit | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent = init?.headers;
      return jsonResponse(CARD);
    };

    await resolveAgentCard('https://peer.example.com', {fetchImpl});

    expect(sent).toBeUndefined();
  });

  it('reports an http error status as a resolution error', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({}, 503);

    const error = await resolveAgentCard('https://peer.example.com', {
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(isAgentCardResolutionError(error)).toBe(true);
    expect((error as Error).message).toContain(
      'Failed to resolve AgentCard from URL https://peer.example.com',
    );
    expect((error as Error).message).toContain('503');
  });

  it('reports an unreachable url as a resolution error', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connection refused');
    };

    const error = await resolveAgentCard('https://peer.example.com', {
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(isAgentCardResolutionError(error)).toBe(true);
    expect((error as Error).message).toContain('connection refused');
  });

  it('aborts a hanging card fetch once the timeout elapses', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted by signal'));
        });
      });

    const error = await resolveAgentCard('https://peer.example.com', {
      timeoutMs: 5,
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(isAgentCardResolutionError(error)).toBe(true);
    expect((error as Error).message).toContain('aborted by signal');
  });

  it('uses the global fetch when no implementation is supplied', async () => {
    const stub = vi.fn(async () => jsonResponse(CARD));
    vi.stubGlobal('fetch', stub);

    const card = await resolveAgentCard('https://peer.example.com');

    expect(card.name).toBe('peer');
    expect(stub).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('reads a card from a file', async () => {
    const file = await writeCardFile(JSON.stringify(CARD));

    await expect(resolveAgentCard(file)).resolves.toMatchObject({name: 'peer'});
  });

  it('reports a missing card file', async () => {
    const missing = path.join(os.tmpdir(), 'adk-no-such-card.json');

    const error = await resolveAgentCard(missing).catch((e: unknown) => e);

    expect(isAgentCardResolutionError(error)).toBe(true);
    expect((error as Error).message).toBe(
      `Agent card file not found: ${missing}`,
    );
  });

  it('reports a card path that is not a file', async () => {
    const file = await writeCardFile('{}');
    const dir = path.dirname(file);

    const error = await resolveAgentCard(dir).catch((e: unknown) => e);

    expect(isAgentCardResolutionError(error)).toBe(true);
    expect((error as Error).message).toContain(
      `Failed to resolve AgentCard from file ${dir}`,
    );
  });

  it('reports invalid JSON in a card file', async () => {
    const file = await writeCardFile('{not json');

    const error = await resolveAgentCard(file).catch((e: unknown) => e);

    expect(isAgentCardResolutionError(error)).toBe(true);
    expect((error as Error).message).toContain(
      `Invalid JSON in agent card file ${file}`,
    );
  });
});

describe('adoptedCardDescription', () => {
  it('adopts a description with no source verbatim', () => {
    expect(adoptedCardDescription('plain')).toBe('plain');
  });

  it('adopts a file-sourced description verbatim', () => {
    expect(adoptedCardDescription('plain', '/tmp/card.json')).toBe('plain');
  });

  it('fences a network-sourced description', () => {
    expect(
      adoptedCardDescription('plain', 'https://peer.example.com/card.json'),
    ).toBe(`${QUOTED_CONTENT_BEGIN}\nplain\n${QUOTED_CONTENT_END}`);
  });

  it('does not mark a short description as truncated', () => {
    const adopted = adoptedCardDescription(
      'short',
      'https://peer.example.com/card.json',
    );

    expect(adopted).not.toContain('[truncated]');
  });

  it('caps a long description and marks it truncated', () => {
    const long = 'x'.repeat(2000);

    const adopted = adoptedCardDescription(
      long,
      'https://peer.example.com/card.json',
    );

    expect(adopted).toContain('... [truncated]');
    expect(adopted).toContain('x'.repeat(1024));
    expect(adopted).not.toContain('x'.repeat(1025));
  });
});
