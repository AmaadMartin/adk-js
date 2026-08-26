/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import * as http from 'node:http';
import {AddressInfo} from 'node:net';
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

describe('resolveAgentCard against a real server', () => {
  const requested: string[] = [];
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requested.push(req.url ?? '');
      if (req.url === '/my-card.json') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify(card));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('fetches the card at the configured path', async () => {
    const resolved = await resolveAgentCard(`${origin}/my-card.json`);

    expect(resolved.name).toBe('live');
    expect(requested).toEqual(['/my-card.json']);
  });

  it('requests the well-known path for a bare origin', async () => {
    requested.length = 0;

    await expect(resolveAgentCard(origin)).rejects.toThrow();

    expect(requested).toEqual(['/.well-known/agent-card.json']);
  });
});
