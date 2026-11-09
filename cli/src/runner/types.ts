/**
 * Runner-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

/**
 * Session tracking for runner
 */
export interface TrackedSession {
  /** All immutable HAPI roots in this shared execution; primary ID remains the spawn ACK. */
  sharedSessions?: Record<string, Metadata>;
  startedBy: 'runner' | string;
  happySessionId?: string;
  /** HAPI row requested for this process generation before its webhook arrives. */
  requestedHappySessionId?: string;
  /** Set only when this child's primary spawn acknowledgement was explicitly
   * retired (its root archived). A child that never received an acknowledgement
   * must still be able to confirm its first webhook. */
  primaryAckRetired?: boolean;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
}
