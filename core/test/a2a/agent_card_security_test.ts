/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {
  agentCardRpcUrls,
  isAgentCardResolutionError,
  isLoopbackHost,
  isRemoteCardSource,
  validateAgentCard,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'peer',
    description: 'a peer',
    protocolVersion: '0.3.0',
    version: '1.0.0',
    url: 'https://peer.example.com/a2a',
    skills: [],
    capabilities: {},
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    ...overrides,
  };
}

const SOURCE = 'https://peer.example.com/.well-known/agent-card.json';

describe('agentCardRpcUrls', () => {
  it('lists the top-level url first, then every extra interface', () => {
    const card = makeCard({
      additionalInterfaces: [
        {url: 'https://peer.example.com/grpc', transport: 'GRPC'},
        {url: 'https://peer.example.com/rest', transport: 'HTTP+JSON'},
      ],
    });

    expect(agentCardRpcUrls(card)).toEqual([
      'https://peer.example.com/a2a',
      'https://peer.example.com/grpc',
      'https://peer.example.com/rest',
    ]);
  });

  it('de-duplicates a repeated url', () => {
    const card = makeCard({
      additionalInterfaces: [
        {url: 'https://peer.example.com/a2a', transport: 'JSONRPC'},
      ],
    });

    expect(agentCardRpcUrls(card)).toEqual(['https://peer.example.com/a2a']);
  });

  it('skips an interface with no url', () => {
    const card = makeCard({
      additionalInterfaces: [{url: '', transport: 'JSONRPC'}],
    });

    expect(agentCardRpcUrls(card)).toEqual(['https://peer.example.com/a2a']);
  });
});

describe('isRemoteCardSource', () => {
  it('is true for http and https and false for a path', () => {
    expect(isRemoteCardSource('http://host/card.json')).toBe(true);
    expect(isRemoteCardSource('https://host/card.json')).toBe(true);
    expect(isRemoteCardSource('/tmp/card.json')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['app.localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['[::1]', true],
    ['::1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['peer.example.com', false],
    ['169.254.169.254', false],
    ['127.0.0.999', false],
    ['127.0.0', false],
    ['notlocalhost', false],
    ['', false],
  ])('classifies %s as loopback=%s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it('is false for a missing hostname', () => {
    expect(isLoopbackHost()).toBe(false);
  });
});

describe('validateAgentCard', () => {
  it('rejects a card with no RPC url', () => {
    expect(() => {
      validateAgentCard(makeCard({url: ''}), SOURCE);
    }).toThrow('Agent card must have a valid URL for RPC communication');
  });

  it('accepts a same-origin https url', () => {
    expect(() => {
      validateAgentCard(makeCard(), SOURCE);
    }).not.toThrow();
  });

  it('treats a default port as the same origin', () => {
    expect(() => {
      validateAgentCard(
        makeCard({url: 'https://peer.example.com:443/a2a'}),
        SOURCE,
      );
    }).not.toThrow();
  });

  it('rejects a cross-origin url', () => {
    expect(() => {
      validateAgentCard(
        makeCard({url: 'https://evil.example.com/a2a'}),
        SOURCE,
      );
    }).toThrow(/must have the same origin/);
  });

  it('rejects a same-host url on another port', () => {
    expect(() => {
      validateAgentCard(
        makeCard({url: 'https://peer.example.com:8443/a2a'}),
        SOURCE,
      );
    }).toThrow(/must have the same origin/);
  });

  it('rejects plain http on a public host', () => {
    expect(() => {
      validateAgentCard(makeCard({url: 'http://peer.example.com/a2a'}), SOURCE);
    }).toThrow(/must use https, or http on a loopback host/);
  });

  it('rejects a link-local metadata endpoint', () => {
    expect(() => {
      validateAgentCard(
        makeCard({url: 'http://169.254.169.254/latest/meta-data/'}),
        SOURCE,
      );
    }).toThrow(/must use https, or http on a loopback host/);
  });

  it('rejects a malformed rpc url', () => {
    expect(() => {
      validateAgentCard(makeCard({url: 'not a url'}), SOURCE);
    }).toThrow(/must use https, or http on a loopback host/);
  });

  it('allows plain http on a loopback host', () => {
    expect(() => {
      validateAgentCard(
        makeCard({url: 'http://localhost:8080/a2a'}),
        'http://localhost:8080/.well-known/agent-card.json',
      );
    }).not.toThrow();
  });

  it('does not origin-check a card that did not come off the network', () => {
    expect(() => {
      validateAgentCard(makeCard({url: 'http://elsewhere.example.com/a2a'}));
    }).not.toThrow();
    expect(() => {
      validateAgentCard(
        makeCard({url: 'http://elsewhere.example.com/a2a'}),
        '/tmp/card.json',
      );
    }).not.toThrow();
  });

  it('rejects an off-origin extra interface', () => {
    const card = makeCard({
      additionalInterfaces: [
        {url: 'https://evil.example.com/grpc', transport: 'GRPC'},
      ],
    });

    expect(() => {
      validateAgentCard(card, SOURCE);
    }).toThrow(/must have the same origin/);
  });

  it('accepts a same-origin extra interface', () => {
    const card = makeCard({
      additionalInterfaces: [
        {url: 'https://peer.example.com/grpc', transport: 'GRPC'},
      ],
    });

    expect(() => {
      validateAgentCard(card, SOURCE);
    }).not.toThrow();
  });

  it('rejects a malformed source url', () => {
    expect(() => {
      validateAgentCard(makeCard(), 'https://');
    }).toThrow('Invalid agent card source URL: https://');
  });

  it('throws an error the name-based guard recognises', () => {
    try {
      validateAgentCard(makeCard({url: ''}), SOURCE);
      expect.fail('validateAgentCard should have thrown');
    } catch (e: unknown) {
      expect(isAgentCardResolutionError(e)).toBe(true);
    }
  });

  it('does not classify an unrelated error as a resolution error', () => {
    expect(isAgentCardResolutionError(new Error('nope'))).toBe(false);
    expect(isAgentCardResolutionError('AgentCardResolutionError')).toBe(false);
  });
});
