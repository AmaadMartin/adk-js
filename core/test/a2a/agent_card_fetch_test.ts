/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import * as http from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {resolveAgentCard} from '../../src/a2a/agent_card.js';

const card: AgentCard = {
  name: 'live',
  description: 'served by a real http server',
  protocolVersion: '1.0',
  defaultInputModes: [],
  defaultOutputModes: [],
  capabilities: {},
  skills: [],
  url: 'http://127.0.0.1',
  version: '1.0',
};

/** Where an A2A server mounted on `/a2a/agent/` serves its card. */
const MOUNTED_CARD_PATH = '/a2a/agent/.well-known/agent-card.json';

/** A path whose doubled slash reads as a host in a relative URL reference. */
const DOUBLED_SLASH_CARD_PATH = '//example.com/card.json';

describe('resolveAgentCard against a real server', () => {
  const requested: string[] = [];
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requested.push(req.url ?? '');
      if (
        req.url === '/my-card.json' ||
        req.url === MOUNTED_CARD_PATH ||
        req.url === DOUBLED_SLASH_CARD_PATH
      ) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify(card));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          origin = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('fetches the card at the configured path', async () => {
    const resolved = await resolveAgentCard(`${origin}/my-card.json`);

    expect(resolved.name).toBe('live');
    expect(requested).toEqual(['/my-card.json']);
  });

  it('never sends the fragment to the server', async () => {
    requested.length = 0;

    const resolved = await resolveAgentCard(`${origin}/my-card.json#skills`);

    expect(resolved.name).toBe('live');
    expect(requested).toEqual(['/my-card.json']);
  });

  it('requests the well-known path for a bare origin', async () => {
    requested.length = 0;

    await expect(resolveAgentCard(origin)).rejects.toThrow(
      `Failed to fetch Agent Card from ${origin}/.well-known/agent-card.json: 404`,
    );

    expect(requested).toEqual(['/.well-known/agent-card.json']);
  });

  it('joins the well-known path onto a mount path', async () => {
    requested.length = 0;

    const resolved = await resolveAgentCard(`${origin}/a2a/agent/`);

    expect(resolved.name).toBe('live');
    expect(requested).toEqual([MOUNTED_CARD_PATH]);
  });

  it('stays on the configured origin when the path has a doubled slash', async () => {
    requested.length = 0;

    const resolved = await resolveAgentCard(
      `${origin}${DOUBLED_SLASH_CARD_PATH}`,
    );

    expect(resolved.name).toBe('live');
    expect(requested).toEqual([DOUBLED_SLASH_CARD_PATH]);
  });
});
