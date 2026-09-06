/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {isIPv4} from 'node:net';

/**
 * Constrains where a card fetched over the network may aim RPC traffic.
 *
 * Every URL the card offers is checked, not only the one this ADK version
 * would select, because the client factory negotiates the endpoint across the
 * card's whole interface list. Each URL must use https and share the origin
 * the card was fetched from. Plain http stays allowed on a loopback host,
 * which is the local-development shape the A2A helpers emit.
 *
 * @param card The card that was just resolved.
 * @param source The http(s) location the card was fetched from.
 * @throws Error when a card URL breaks the scheme rule or the origin rule.
 */
export function assertCardRpcTargetsAllowed(
  card: AgentCard,
  source: string,
): void {
  const sourceUrl = parseUrl(source);
  if (!sourceUrl) {
    throw new Error(`Invalid agent card source URL: ${source}`);
  }

  for (const url of cardRpcUrls(card)) {
    const target = parseUrl(url);
    if (!target) {
      throw new Error(`Invalid RPC URL in agent card: ${url}`);
    }
    if (target.protocol !== 'https:' && !isLoopbackHost(target.hostname)) {
      throw new Error(
        `Agent card RPC URL must use https, or http on a loopback host: ${url}`,
      );
    }
    if (target.origin !== sourceUrl.origin) {
      throw new Error(
        'Agent card RPC URL must have the same origin as the location the ' +
          `card was fetched from (${source}): ${url}`,
      );
    }
  }
}

/**
 * Returns every URL on a card that a client may send RPC traffic to: the
 * top-level `url` followed by every `additionalInterfaces[i].url`, in card
 * order.
 */
function cardRpcUrls(card: AgentCard): string[] {
  const candidates = [
    card.url,
    ...(card.additionalInterfaces ?? []).map((iface) => iface.url),
  ];
  return candidates.filter((url) => !!url);
}

/**
 * Returns whether a hostname from a parsed URL names the local machine.
 *
 * Covers `localhost`, the reserved `*.localhost` names and the literal
 * loopback addresses. An unrecognised loopback form is merely rejected, never
 * wrongly allowed.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (isIPv4(host)) {
    return host.startsWith('127.');
  }
  return host === '::1';
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
