/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';

/** Error thrown when an agent card cannot be resolved or is not acceptable. */
export class AgentCardResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCardResolutionError';
  }
}

/**
 * Whether `value` is an {@link AgentCardResolutionError}.
 *
 * Name-based rather than `instanceof`: two copies of this package in one
 * runtime produce two distinct classes, and `instanceof` then returns false
 * for an error the other copy threw.
 */
export function isAgentCardResolutionError(
  value: unknown,
): value is AgentCardResolutionError {
  return value instanceof Error && value.name === 'AgentCardResolutionError';
}

/** Whether `source` names a location the card is fetched from over HTTP. */
export function isRemoteCardSource(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://');
}

/**
 * Returns every URL on a card that a client may send RPC traffic to.
 *
 * The client factory negotiates the endpoint across the card's whole
 * interface list, so a caller constraining the destination must consider all
 * of them, not only the top-level `url`.
 */
export function agentCardRpcUrls(card: AgentCard): string[] {
  const candidates = [
    card.url,
    ...(card.additionalInterfaces ?? []).map((iface) => iface.url),
  ];
  const urls: string[] = [];
  for (const url of candidates) {
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

const IPV6_LOOPBACK_SPELLINGS = new Set(['::1', '0:0:0:0:0:0:0:1']);

/**
 * Whether a hostname names the local machine.
 *
 * Covers `localhost` and the reserved `*.localhost` names as well as the
 * loopback addresses, so the local-development shape the A2A helpers emit --
 * a plain-http card served from `localhost` -- keeps working.
 */
export function isLoopbackHost(hostname?: string): boolean {
  if (!hostname) {
    return false;
  }
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    IPV6_LOOPBACK_SPELLINGS.has(host) ||
    isLoopbackIpv4(host)
  );
}

function isLoopbackIpv4(host: string): boolean {
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function sameOrigin(a: URL, b: URL): boolean {
  // `URL.port` is normalised to the empty string for the protocol default, so
  // `https://host` and `https://host:443` compare equal.
  return (
    a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
  );
}

function tryParseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * Constrains where a card fetched over the network may aim RPC traffic.
 *
 * Every URL the card offers must be https, or http on a loopback host, and
 * must share the origin the card was fetched from. A card passed in directly
 * or read from a local file did not come off the network here, so its target
 * is left to the caller.
 *
 * @param card - The resolved agent card.
 * @param source - The location the card was fetched from, when it was fetched
 *   over HTTP.
 * @throws {@link AgentCardResolutionError} when a URL is missing, malformed,
 *   not https on a non-loopback host, or points at another origin.
 */
export function validateAgentCard(card: AgentCard, source?: string): void {
  const rpcUrls = agentCardRpcUrls(card);
  if (rpcUrls.length === 0) {
    throw new AgentCardResolutionError(
      'Agent card must have a valid URL for RPC communication',
    );
  }
  if (!source || !isRemoteCardSource(source)) {
    return;
  }

  const sourceOrigin = tryParseUrl(source);
  if (!sourceOrigin) {
    throw new AgentCardResolutionError(
      `Invalid agent card source URL: ${source}`,
    );
  }

  for (const url of rpcUrls) {
    // A malformed URL has no scheme and no hostname to accept, so it fails the
    // same check rather than needing a branch of its own.
    const cardUrl = tryParseUrl(url);
    if (
      !cardUrl ||
      (cardUrl.protocol !== 'https:' && !isLoopbackHost(cardUrl.hostname))
    ) {
      throw new AgentCardResolutionError(
        `Agent card RPC URL must use https, or http on a loopback host: ${url}`,
      );
    }
    if (!sameOrigin(cardUrl, sourceOrigin)) {
      throw new AgentCardResolutionError(
        'Agent card RPC URL must have the same origin as the location the' +
          ` card was fetched from (${source}): ${url}`,
      );
    }
  }
}
