/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {isAgentCardResolutionError} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {validateAgentCard} from '../../src/a2a/agent_card_validation.js';

const SOURCE = 'https://remote.example.com/.well-known/agent-card.json';

function cardWithUrl(url: string, additional?: string[]): AgentCard {
  return {
    name: 'remote',
    description: 'a remote agent',
    protocolVersion: '0.3.0',
    version: '1.0.0',
    url,
    skills: [],
    capabilities: {},
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    ...(additional
      ? {
          additionalInterfaces: additional.map((entry) => ({
            url: entry,
            transport: 'JSONRPC',
          })),
        }
      : {}),
  };
}

/** Asserts that validation refuses the card with a message containing `part`. */
function expectRejected(card: AgentCard, source: string, part: string): void {
  try {
    validateAgentCard(card, source);
  } catch (err: unknown) {
    if (!isAgentCardResolutionError(err)) {
      expect.fail(`expected an AgentCardResolutionError, got ${String(err)}`);
    }
    expect(err.message).toContain(part);
    return;
  }
  expect.fail(`expected validateAgentCard to reject: ${part}`);
}

describe('validateAgentCard', () => {
  it('accepts a same-origin https RPC URL', () => {
    expect(() =>
      validateAgentCard(cardWithUrl('https://remote.example.com/a2a'), SOURCE),
    ).not.toThrow();
  });

  it('accepts an https RPC URL that spells out the default port', () => {
    expect(() =>
      validateAgentCard(
        cardWithUrl('https://remote.example.com:443/a2a'),
        SOURCE,
      ),
    ).not.toThrow();
  });

  it('rejects a cross-origin RPC URL', () => {
    expectRejected(
      cardWithUrl('https://attacker.example.net/a2a'),
      SOURCE,
      'must have the same origin as the location the card was fetched from',
    );
  });

  it('rejects a same-host RPC URL on a different port', () => {
    expectRejected(
      cardWithUrl('https://remote.example.com:8443/a2a'),
      SOURCE,
      'must have the same origin',
    );
  });

  it('rejects plain http on a non-loopback host', () => {
    expectRejected(
      cardWithUrl('http://remote.example.com/a2a'),
      'http://remote.example.com/card.json',
      'must use https, or http on a loopback host',
    );
  });

  it.each([
    'http://localhost:8080/a2a',
    'http://127.0.0.1:8080/a2a',
    'http://[::1]:8080/a2a',
    'http://agent.localhost:8080/a2a',
  ])('accepts the loopback RPC URL %s', (url) => {
    const source = `${new URL(url).origin}/card.json`;

    expect(() => validateAgentCard(cardWithUrl(url), source)).not.toThrow();
  });

  it('rejects a registered name that only looks like a loopback address', () => {
    expectRejected(
      cardWithUrl('http://127.0.0.1.example.com/a2a'),
      'http://127.0.0.1.example.com/card.json',
      'must use https, or http on a loopback host',
    );
  });

  it('rejects an off-origin additionalInterfaces entry', () => {
    expectRejected(
      cardWithUrl('https://remote.example.com/a2a', [
        'https://attacker.example.net/a2a',
      ]),
      SOURCE,
      'https://attacker.example.net/a2a',
    );
  });

  it('accepts a same-origin additionalInterfaces entry', () => {
    expect(() =>
      validateAgentCard(
        cardWithUrl('https://remote.example.com/a2a', [
          'https://remote.example.com/grpc',
        ]),
        SOURCE,
      ),
    ).not.toThrow();
  });

  it('leaves a card that did not come off the network unchecked', () => {
    expect(() =>
      validateAgentCard(cardWithUrl('http://attacker.example.net/a2a')),
    ).not.toThrow();
  });

  it('rejects a card with no RPC URL', () => {
    expectRejected(
      cardWithUrl(''),
      SOURCE,
      'Agent card must have a valid URL for RPC communication',
    );
  });

  it('rejects a malformed RPC URL', () => {
    expectRejected(
      cardWithUrl('not-a-url'),
      SOURCE,
      'Invalid RPC URL in agent card: not-a-url',
    );
  });

  it('rejects a malformed card source URL', () => {
    expectRejected(
      cardWithUrl('https://remote.example.com/a2a'),
      'https://',
      'Invalid agent card source URL: https://',
    );
  });
});
