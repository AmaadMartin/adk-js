/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {isIP} from 'node:net';
import {AgentCardResolutionError} from './agent_card.js';

/**
 * Constrains where a card fetched over the network may aim RPC traffic.
 *
 * Every URL the card offers is checked, not only the one this ADK version would
 * select, because the client factory negotiates the endpoint across the card's
 * whole interface list. Each must be https and share the origin the card was
 * fetched from. Plain http stays allowed on a loopback host, the
 * local-development shape the A2A helpers emit.
 *
 * A card passed in directly or read from a local file did not come off the
 * network here, so its target is left to the caller.
 *
 * Ported from `google/adk-python`
 * `agents/remote_a2a_agent.py::RemoteA2aAgent._validate_agent_card`.
 *
 * @param card The resolved agent card.
 * @param source The location the card was fetched from, when it was fetched
 *   over the network.
 * @throws {AgentCardResolutionError} If the card names no RPC URL, names a
 *   malformed one, or aims at an origin the card did not come from.
 */
export function validateAgentCard(card: AgentCard, source?: string): void {
  if (!card.url) {
    throw new AgentCardResolutionError(
      'Agent card must have a valid URL for RPC communication',
    );
  }

  const rpcUrls = [
    card.url,
    ...(card.additionalInterfaces ?? []).map((iface) => iface.url),
  ];
  const sourceOrigin = source ? parseOrigin(source) : undefined;

  for (const rpcUrl of rpcUrls) {
    const url = parseRpcUrl(rpcUrl);
    if (!sourceOrigin) {
      continue;
    }
    if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
      throw new AgentCardResolutionError(
        `Agent card RPC URL must use https, or http on a loopback host: ${rpcUrl}`,
      );
    }
    if (url.origin !== sourceOrigin) {
      throw new AgentCardResolutionError(
        'Agent card RPC URL must have the same origin as the location the' +
          ` card was fetched from (${source}): ${rpcUrl}`,
      );
    }
  }
}

/** Parses an RPC URL the card offers, rejecting anything unparseable. */
function parseRpcUrl(rpcUrl: string): URL {
  try {
    return new URL(rpcUrl);
  } catch {
    throw new AgentCardResolutionError(
      `Invalid RPC URL in agent card: ${rpcUrl}`,
    );
  }
}

/**
 * Returns the origin of a card source URL. `URL.origin` normalises the default
 * port away, so `https://host:443` and `https://host` compare equal.
 */
function parseOrigin(source: string): string {
  try {
    return new URL(source).origin;
  } catch {
    throw new AgentCardResolutionError(
      `Invalid agent card source URL: ${source}`,
    );
  }
}

/**
 * Whether a hostname names the local machine.
 *
 * Covers `localhost` and the reserved `*.localhost` names as well as the
 * literal loopback addresses. `URL` canonicalises a host before it reaches
 * here, so `127.1` arrives as `127.0.0.1` and `[0:0:0:0:0:0:0:1]` as `[::1]`.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return true;
  }
  // Only a real IPv4 literal counts, so a registered name that merely starts
  // with the loopback prefix -- `127.0.0.1.example.com` -- does not.
  return isIP(host) === 4 && host.startsWith('127.');
}
