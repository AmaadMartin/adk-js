/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {isIP} from 'node:net';
import {AgentCardResolutionError} from './agent_card.js';

/** Every URL a client may aim RPC traffic at, in card order. */
function cardRpcUrls(card: AgentCard): string[] {
  return [
    card.url,
    ...(card.additionalInterfaces ?? []).map((iface) => iface.url),
  ].filter((url): url is string => !!url);
}

/**
 * Whether a hostname names the local machine.
 *
 * Covers `localhost` and the reserved `*.localhost` names as well as the
 * literal loopback addresses, so the local-development pattern the A2A helpers
 * emit -- a plain-http card served from `localhost` -- keeps working.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  switch (isIP(host)) {
    case 4:
      return host.startsWith('127.');
    case 6:
      return host === '::1';
    default:
      return false;
  }
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * Constrains where a card fetched over the network may aim RPC traffic.
 *
 * Every URL the card offers is checked, not only the one this ADK version
 * would select, because the client factory negotiates the endpoint across the
 * card's whole interface list. Each must use https and share the origin the
 * card was fetched from; plain http stays allowed on a loopback host.
 *
 * @throws {AgentCardResolutionError} When a card URL breaks either rule.
 */
function assertCardRpcTargetsAllowed(card: AgentCard, source: string): void {
  const sourceUrl = parseUrl(source);
  if (!sourceUrl) {
    throw new AgentCardResolutionError(
      `Invalid agent card source URL: ${source}`,
    );
  }

  for (const url of cardRpcUrls(card)) {
    const target = parseUrl(url);
    if (!target) {
      throw new AgentCardResolutionError(
        `Invalid RPC URL in agent card: ${url}`,
      );
    }
    if (target.protocol !== 'https:' && !isLoopbackHost(target.hostname)) {
      throw new AgentCardResolutionError(
        `Agent card RPC URL must use https, or http on a loopback host: ${url}`,
      );
    }
    if (target.origin !== sourceUrl.origin) {
      throw new AgentCardResolutionError(
        'Agent card RPC URL must have the same origin as the location the ' +
          `card was fetched from (${source}): ${url}`,
      );
    }
  }
}

/**
 * Validates a resolved agent card before the agent talks to it.
 *
 * A card given as an object is the caller's own configuration, so it never
 * reaches here. A card read from a local file must still name an RPC endpoint,
 * but only a card fetched over http(s) has its RPC targets constrained.
 *
 * @param card The card that was just resolved.
 * @param source The location the card was resolved from.
 * @throws {AgentCardResolutionError} When the card names no usable RPC target.
 */
export function validateAgentCard(card: AgentCard, source: string): void {
  if (!card.url) {
    throw new AgentCardResolutionError(
      'Agent card must have a valid URL for RPC communication',
    );
  }
  if (!parseUrl(card.url)) {
    throw new AgentCardResolutionError(
      `Invalid RPC URL in agent card: ${card.url}`,
    );
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    assertCardRpcTargetsAllowed(card, source);
  }
}
