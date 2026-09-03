/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, AgentInterface} from '@a2a-js/sdk';
import {isAgentCardResolutionError} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {adoptedCardDescription} from '../../src/a2a/agent_card.js';
import {validateAgentCard} from '../../src/a2a/agent_card_validation.js';
import {
  QUOTED_CONTENT_BEGIN,
  QUOTED_CONTENT_END,
} from '../../src/utils/fencing_utils.js';

const REMOTE_SOURCE = 'https://peer.example.com/.well-known/agent-card.json';

function card(url: string, additionalInterfaces?: AgentInterface[]): AgentCard {
  return {
    name: 'peer',
    description: 'a peer',
    protocolVersion: '0.3.0',
    version: '1.0.0',
    url,
    ...(additionalInterfaces ? {additionalInterfaces} : {}),
    capabilities: {streaming: true},
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  };
}

describe('validateAgentCard rpc targets', () => {
  it('accepts a same-origin https RPC URL', () => {
    expect(() =>
      validateAgentCard(card('https://peer.example.com/a2a'), REMOTE_SOURCE),
    ).not.toThrow();
  });

  it('rejects a cross-origin RPC URL', () => {
    expect(() =>
      validateAgentCard(
        card('https://attacker.example.net/a2a'),
        REMOTE_SOURCE,
      ),
    ).toThrow(/must have the same origin as the location the card was fetched/);
  });

  it('rejects a same-host RPC URL on a different port', () => {
    expect(() =>
      validateAgentCard(
        card('https://peer.example.com:8443/a2a'),
        REMOTE_SOURCE,
      ),
    ).toThrow(/same origin/);
  });

  it('rejects plain http on a public host', () => {
    expect(() =>
      validateAgentCard(card('http://peer.example.com/a2a'), REMOTE_SOURCE),
    ).toThrow(/must use https, or http on a loopback host/);
  });

  it.each([
    'http://localhost:8080/a2a',
    'http://127.0.0.1:8080/a2a',
    'http://[::1]:8080/a2a',
    'http://foo.localhost:8080/a2a',
  ])('accepts %s when the card was fetched from that origin', (url) => {
    const source = new URL(url).origin + '/.well-known/agent-card.json';
    expect(() => validateAgentCard(card(url), source)).not.toThrow();
  });

  it('checks every additional interface, not only the primary URL', () => {
    const bad = card('https://peer.example.com/a2a', [
      {url: 'https://peer.example.com/grpc', transport: 'GRPC'},
      {url: 'https://attacker.example.net/grpc', transport: 'GRPC'},
    ]);
    expect(() => validateAgentCard(bad, REMOTE_SOURCE)).toThrow(
      /attacker\.example\.net/,
    );
  });

  it('rejects a card that names no RPC URL', () => {
    expect(() => validateAgentCard(card(''), REMOTE_SOURCE)).toThrow(
      'Agent card must have a valid URL for RPC communication',
    );
  });

  it('rejects a malformed RPC URL', () => {
    expect(() => validateAgentCard(card('not a url'), REMOTE_SOURCE)).toThrow(
      /Invalid RPC URL in agent card/,
    );
  });

  it('rejects a malformed additional-interface URL', () => {
    const bad = card('https://peer.example.com/a2a', [
      {url: '::::', transport: 'GRPC'},
    ]);
    expect(() => validateAgentCard(bad, REMOTE_SOURCE)).toThrow(
      /Invalid RPC URL in agent card/,
    );
  });

  it('rejects a malformed source URL', () => {
    expect(() =>
      validateAgentCard(
        card('https://peer.example.com/a2a'),
        'https://:99999a',
      ),
    ).toThrow(/Invalid agent card source URL/);
  });

  it('leaves a file-sourced card free to name any origin', () => {
    expect(() =>
      validateAgentCard(
        card('http://elsewhere.example.net/a2a'),
        '/tmp/card.json',
      ),
    ).not.toThrow();
  });

  it('raises AgentCardResolutionError, recognised by its guard', () => {
    try {
      validateAgentCard(card('http://peer.example.com/a2a'), REMOTE_SOURCE);
      expect.fail('validateAgentCard should have thrown');
    } catch (err: unknown) {
      expect(isAgentCardResolutionError(err)).toBe(true);
    }
  });

  it('does not mistake an unrelated error for a resolution error', () => {
    expect(isAgentCardResolutionError(new Error('nope'))).toBe(false);
    expect(isAgentCardResolutionError('nope')).toBe(false);
  });
});

describe('adoptedCardDescription', () => {
  it('fences a description that arrived over the network', () => {
    expect(adoptedCardDescription('helpful peer', REMOTE_SOURCE)).toBe(
      `${QUOTED_CONTENT_BEGIN}\nhelpful peer\n${QUOTED_CONTENT_END}`,
    );
  });

  it('caps an over-long description and marks it truncated', () => {
    const long = 'x'.repeat(1200);
    const adopted = adoptedCardDescription(long, REMOTE_SOURCE);
    expect(adopted).toContain('x'.repeat(1024) + '... [truncated]');
    expect(adopted).not.toContain('x'.repeat(1025));
  });

  it('adds no truncation marker at exactly the cap', () => {
    const exact = 'y'.repeat(1024);
    expect(adoptedCardDescription(exact, REMOTE_SOURCE)).not.toContain(
      '[truncated]',
    );
  });

  it('adopts a file-sourced description verbatim', () => {
    expect(adoptedCardDescription('local peer', '/tmp/card.json')).toBe(
      'local peer',
    );
  });
});
