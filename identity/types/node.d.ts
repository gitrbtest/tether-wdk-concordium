import type { IdentityStore } from './index.js';

/** Options for listenForIdentityCallback. */
export interface ListenForIdentityCallbackOptions {
  /** Port on 127.0.0.1; 0 (the default) picks a free one. */
  port?: number;
  /** Stop waiting after this long, in milliseconds. Defaults to 900000 (15 minutes). */
  timeoutMs?: number;
  /** Cancels the wait, e.g. from a Cancel button. */
  signal?: AbortSignal;
}

export interface IdentityCallbackListener {
  /** The return address to pass to createIdentityRequest: http://127.0.0.1:<port>/identity-callback/<secret>. */
  readonly redirectUri: string;
  /**
   * Resolves with the full address the browser arrived at (pass it to retrieveIdentity).
   * Rejects with IdentityIssuanceError reason 'timeout' or 'cancelled'.
   */
  readonly callback: Promise<string>;
  /** Stop listening early; the callback then rejects with reason 'cancelled'. Safe to call more than once. */
  close(): void;
}

/**
 * Start listening for the identity provider's callback on this machine (Node.js only).
 * The listener accepts one callback, from 127.0.0.1 only, at a random secret path, then closes.
 * @throws {IdentityIssuanceError} reason 'cancelled' if the signal is already aborted.
 */
export function listenForIdentityCallback(options?: ListenForIdentityCallbackOptions): Promise<IdentityCallbackListener>;

/**
 * An IdentityStore keeping encrypted identities in files: <folder>/concordium-identity/<network>/<provider>/<identity>.bin.
 * Creates the folder when needed; writes safely (a temporary file, then one replacing step); owner-only
 * permissions where the operating system supports them; slot names can never point outside the folder.
 */
export class FileIdentityStore implements IdentityStore {
  /** @param folder Where to keep the files; created when needed. */
  constructor(folder: string);
  save(slotName: string, bytes: Uint8Array): Promise<void>;
  read(slotName: string): Promise<Uint8Array | null>;
  delete(slotName: string): Promise<void>;
}
