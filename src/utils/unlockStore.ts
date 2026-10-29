/**
 * "Remember this device for 7 days" (as AtDo): the unlock token the server
 * issued for this browser, so the security PIN is not asked again until it
 * expires. The server stops honouring it after 7 days, never extends it, and
 * can revoke it ("sign out other devices"), so nothing here lasts longer.
 */
const keyFor = (username: string) => `hrt-unlock-device:${encodeURIComponent(username)}`;

export interface RememberedUnlock {
  token: string;
  id: string;
  expiresAt: number;
}

export function loadRememberedUnlock(username: string): RememberedUnlock | null {
  try {
    const value = JSON.parse(localStorage.getItem(keyFor(username)) || 'null') as RememberedUnlock | null;
    if (!value || typeof value.token !== 'string' || typeof value.expiresAt !== 'number') return null;
    if (value.expiresAt <= Date.now()) {
      localStorage.removeItem(keyFor(username));
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function saveRememberedUnlock(username: string, value: RememberedUnlock) {
  try {
    localStorage.setItem(keyFor(username), JSON.stringify(value));
  } catch {
    // Private browsing / quota: the PIN is simply asked next time.
  }
}

export function clearRememberedUnlock(username: string | null | undefined) {
  if (!username) return;
  try {
    localStorage.removeItem(keyFor(username));
  } catch {
    // nothing stored
  }
}
