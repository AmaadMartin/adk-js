/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, AgentInterface} from '@a2a-js/sdk';
import {describe, expect, it} from 'vitest';
import {assertCardRpcTargetsAllowed} from '../../src/a2a/agent_card_validation.js';

function makeCard(
  url: string,
  additionalInterfaces?: AgentInterface[],
): AgentCard {
  return {
    name: 'Remote',
    description: 'test',
    protocolVersion: '0.3.0',
    version: '1.0',
    url,
    additionalInterfaces,
    capabilities: {streaming: true},
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  };
}

const REMOTE_SOURCE = 'https://example.com/agent.json';

describe('assertCardRpcTargetsAllowed', () => {
  it('accepts a same-origin https card', () => {
    expect(() =>
      assertCardRpcTargetsAllowed(
        makeCard('https://example.com/rpc'),
        REMOTE_SOURCE,
      ),
    ).not.toThrow();
  });

  it('rejects a cross-origin https card', () => {
    expect(() =>
      assertCardRpcTargetsAllowed(
        makeCard('https://attacker.example.net/rpc'),
        REMOTE_SOURCE,
      ),
    ).toThrow(/same origin/);
  });

  it('rejects plain http on a non-loopback host', () => {
    expect(() =>
      assertCardRpcTargetsAllowed(
        makeCard('http://example.com/rpc'),
        REMOTE_SOURCE,
      ),
    ).toThrow(/must use https/);
  });

  it.each([
    'http://127.0.0.1:8080/rpc',
    'http://[::1]:8080/rpc',
    'http://169.254.169.254/rpc',
    'http://metadata.internal/rpc',
  ])('rejects %s when the card came from a remote origin', (url) => {
    expect(() =>
      assertCardRpcTargetsAllowed(makeCard(url), REMOTE_SOURCE),
    ).toThrow();
  });

  it.each([
    [
      'http://localhost:8000/.well-known/agent-card.json',
      'http://localhost:8000/a2a',
    ],
    [
      'http://127.0.0.1:8000/.well-known/agent-card.json',
      'http://127.0.0.1:8000/a2a',
    ],
    ['http://[::1]:8000/.well-known/agent-card.json', 'http://[::1]:8000/a2a'],
  ])('accepts loopback http served from %s', (source, url) => {
    expect(() =>
      assertCardRpcTargetsAllowed(makeCard(url), source),
    ).not.toThrow();
  });

  it('accepts a card url that spells out the default port', () => {
    expect(() =>
      assertCardRpcTargetsAllowed(
        makeCard('https://example.com:443/rpc'),
        REMOTE_SOURCE,
      ),
    ).not.toThrow();
  });

  it('rejects an off-origin additional interface behind an allowed url', () => {
    const card = makeCard('https://example.com/rpc', [
      {url: 'http://169.254.169.254/', transport: 'JSONRPC'},
    ]);

    expect(() => assertCardRpcTargetsAllowed(card, REMOTE_SOURCE)).toThrow(
      /must use https/,
    );
  });

  it('accepts several same-origin interfaces', () => {
    const card = makeCard('https://example.com/rpc', [
      {url: 'https://example.com/rpc', transport: 'JSONRPC'},
      {url: 'https://example.com/rest', transport: 'HTTP+JSON'},
    ]);

    expect(() =>
      assertCardRpcTargetsAllowed(card, REMOTE_SOURCE),
    ).not.toThrow();
  });

  it.each(['/rpc', 'not a url'])(
    'rejects the unparseable card url %s',
    (url) => {
      expect(() =>
        assertCardRpcTargetsAllowed(makeCard(url), REMOTE_SOURCE),
      ).toThrow(/Invalid RPC URL in agent card/);
    },
  );

  it('rejects an unparseable source url', () => {
    expect(() =>
      assertCardRpcTargetsAllowed(
        makeCard('https://example.com/rpc'),
        'http://',
      ),
    ).toThrow(/Invalid agent card source URL/);
  });

  it('skips an empty additional interface url', () => {
    const card = makeCard('https://example.com/rpc', [
      {url: '', transport: 'JSONRPC'},
    ]);

    expect(() =>
      assertCardRpcTargetsAllowed(card, REMOTE_SOURCE),
    ).not.toThrow();
  });

  it('accepts a subdomain of localhost', () => {
    expect(() =>
      assertCardRpcTargetsAllowed(
        makeCard('http://app.localhost:8000/a2a'),
        'http://app.localhost:8000/agent.json',
      ),
    ).not.toThrow();
  });
});
