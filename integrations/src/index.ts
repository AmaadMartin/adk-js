/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {version} from './version.js';

// Node only: the Firestore client has no browser build, so `index_web.ts` does
// not re-export this.
export {
  DEFAULT_APP_STATE_COLLECTION,
  DEFAULT_EVENTS_COLLECTION,
  DEFAULT_ROOT_COLLECTION,
  DEFAULT_SESSIONS_COLLECTION,
  DEFAULT_USER_STATE_COLLECTION,
  FirestoreSessionService,
  type FirestoreSessionServiceOptions,
} from './firestore/firestore_session_service.js';
