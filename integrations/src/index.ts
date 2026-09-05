/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {version} from './version.js';

// Node only: the Firestore client has no browser build, so `index_web.ts` does
// not re-export this.
export {
  DEFAULT_ROOT_COLLECTION,
  FirestoreSessionService,
  type FirestoreSessionServiceOptions,
} from './firestore/firestore_session_service.js';
