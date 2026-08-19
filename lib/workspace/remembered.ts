"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Preview settings that outlive a refresh.
 *
 * How someone likes to look at a page — beside a phone, at tablet width, the
 * phone at half size — is a preference about reviewing, not about the version
 * being reviewed. Resetting it on every refresh meant setting it again on every
 * refresh, several times an hour.
 *
 * Kept for a week rather than forever. A preference nobody has exercised in
 * that long is more likely to be a forgotten setting than a choice, and coming
 * back to a tool that opens the way it always used to is a better surprise than
 * one that opens the way you left it in another month.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIX = "copy-updater/";

interface Stored {
  v: unknown;
  at: number;
}

/** Minimal shape of `localStorage`, so this can be tested without a browser. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Read a remembered value, or null if there is nothing usable.
 *
 * Anything unparseable, expired, or no longer valid is treated as absent and
 * removed — a stored viewport that a later build stopped offering should not
 * strand someone on a width the picker cannot show.
 */
export function readRemembered<T>(
  store: KeyValueStore,
  key: string,
  valid: (value: unknown) => value is T,
  now: number = Date.now(),
): T | null {
  let raw: string | null;
  try {
    raw = store.getItem(PREFIX + key);
  } catch {
    // Storage can be denied outright — private browsing, blocked cookies. A
    // preference is never worth failing over.
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as Stored;
    if (typeof parsed?.at !== "number" || now - parsed.at > TTL_MS) {
      store.removeItem(PREFIX + key);
      return null;
    }
    return valid(parsed.v) ? parsed.v : null;
  } catch {
    store.removeItem(PREFIX + key);
    return null;
  }
}

export function writeRemembered(
  store: KeyValueStore,
  key: string,
  value: unknown,
  now: number = Date.now(),
): void {
  try {
    store.setItem(PREFIX + key, JSON.stringify({ v: value, at: now } satisfies Stored));
  } catch {
    // Quota, or storage denied. Nothing here is worth interrupting a review.
  }
}

/**
 * State that survives a refresh.
 *
 * The stored value is applied *after* mounting rather than used as the initial
 * state, because the server renders the fallback and React must be handed the
 * same thing on the client or it complains the two disagree. The cost is one
 * frame at the default, which for a preview toggle nobody notices.
 */
export function useRemembered<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = readRemembered(window.localStorage, key, valid);
    if (stored !== null) setValue(stored);
    // Deliberately once, on mount: this restores a preference, it does not
    // follow the key or the validator changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      if (typeof window !== "undefined") writeRemembered(window.localStorage, key, next);
    },
    [key],
  );

  return [value, set];
}
