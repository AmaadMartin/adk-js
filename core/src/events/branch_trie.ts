/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from './event.js';

/**
 * A node inside the EventBranchTrie representing a branch path segment.
 */
export interface BranchTrieNode {
  /** Map of child segment names to child Trie nodes. */
  children: Map<string, BranchTrieNode>;
  /** List of events exactly stored at this branch path node. */
  events: Event[];
}

/**
 * Parses a branch path string into its dot-separated segments.
 * Ignores empty or redundant segments.
 */
function getBranchSegments(branch?: string): string[] {
  return branch?.split('.').filter((segment) => segment.trim() !== '') ?? [];
}

/**
 * A prefix tree (Trie) data structure for indexing and querying session events
 * by their hierarchical, dot-separated branch path segments.
 */
export class EventBranchTrie {
  readonly root: BranchTrieNode = {
    children: new Map<string, BranchTrieNode>(),
    events: [],
  };

  private eventInsertOrder = new WeakMap<Event, number>();
  private insertCount = 0;

  /**
   * Creates an EventBranchTrie and populates it with the provided events.
   *
   * @param events The list of events to insert.
   * @returns A new EventBranchTrie containing all the events.
   */
  static fromEvents(events: Event[]): EventBranchTrie {
    const trie = new EventBranchTrie();
    for (const event of events) {
      trie.insert(event);
    }
    return trie;
  }

  /**
   * Inserts an event into the Trie based on its branch property.
   *
   * Events where `event.branch` is undefined or empty represent root/global
   * events and are stored at the root node of the Trie.
   *
   * @param event The event to insert into the Trie.
   */
  insert(event: Event): void {
    const segments = getBranchSegments(event.branch);

    let currentNode = this.root;
    for (const segment of segments) {
      let child = currentNode.children.get(segment);
      if (!child) {
        child = {
          children: new Map<string, BranchTrieNode>(),
          events: [],
        };
        currentNode.children.set(segment, child);
      }
      currentNode = child;
    }

    currentNode.events.push(event);

    if (!this.eventInsertOrder.has(event)) {
      this.eventInsertOrder.set(event, this.insertCount++);
    }
  }

  /**
   * Retrieves all events belonging to the hierarchy of `currentBranch`.
   *
   * Walks down the Trie nodes matching the dot-separated segments of `currentBranch`.
   * Returns all events stored at each visited ancestor node (and the target node itself).
   * If `currentBranch` is undefined or empty, only root/global events (stored at the root node) are returned.
   *
   * @param currentBranch The branch path to query for matching events.
   * @returns All matching events in their exact insertion order.
   */
  getMatchingEvents(currentBranch?: string): Event[] {
    const segments = getBranchSegments(currentBranch);
    const matchedEvents: Event[] = [];
    let currentNode: BranchTrieNode | undefined = this.root;
    let visitedNodeCount = 0;

    while (currentNode) {
      if (currentNode.events.length > 0) {
        matchedEvents.push(...currentNode.events);
        visitedNodeCount++;
      }
      const segment = segments.shift();
      if (segment === undefined) break;
      currentNode = currentNode.children.get(segment);
    }

    if (visitedNodeCount > 1) {
      matchedEvents.sort((a, b) => {
        const indexA = this.eventInsertOrder.get(a);
        const indexB = this.eventInsertOrder.get(b);
        if (indexA !== undefined && indexB !== undefined) {
          return indexA - indexB;
        }
        return a.timestamp - b.timestamp;
      });
    }

    return matchedEvents;
  }
}

/**
 * Filters a list of session events to include only those matching the branch hierarchy
 * of `currentBranch` using an `EventBranchTrie`.
 *
 * @param events The list of session events.
 * @param currentBranch The current branch path string.
 * @returns The filtered list of events matching `currentBranch`.
 */
export function filterEventsByBranch(
  events: Event[],
  currentBranch?: string,
): Event[] {
  return EventBranchTrie.fromEvents(events).getMatchingEvents(currentBranch);
}
