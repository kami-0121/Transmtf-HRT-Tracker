import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import apiClient from '../api/client';
import { useAuth } from './AuthContext';
import { useSecurityPassword } from './SecurityPasswordContext';
import { computeDataHash, projectForSync, resolveThemeMode, SYNC_HASH_SCHEMA } from '../utils/dataHash';
import { classifyChanges } from '../utils/syncDecision';
import { mergeSnapshots, pickMergeFields } from '../utils/syncMerge';
import { DEFAULT_WEIGHT_KG } from '../utils/weight';
import { isLogoutInProgress } from '../utils/authSessionState';
import { CLOUD_BACKEND } from '../api/config';
import type { ConflictState, FieldDiff } from '../components/SyncConflictModal';

interface CloudSyncContextType {
  isSyncing: boolean;
  lastSyncTime: Date | null;
  syncError: string | null;
  pendingConflict: ConflictState | null;
  resolveConflict: (resolution: 'local' | 'cloud' | 'merge', mergedData?: Record<string, any>) => void;
  /** Sync immediately (manual "back up now"). */
  syncNow: () => void;
}

const CloudSyncContext = createContext<CloudSyncContextType | undefined>(undefined);

const LAST_SYNC_TIME_KEY = 'hrt-last-sync-time';
const LAST_PULL_TIME_KEY = 'hrt-last-pull-time';
const LAST_DATA_UPDATED_KEY = 'hrt-last-data-updated';
const LAST_KNOWN_CLOUD_UPDATED_KEY = 'hrt-last-known-cloud-updated';
const LAST_KNOWN_CLOUD_HASH_KEY = 'hrt-last-known-cloud-hash';
// The synced fields of the baseline itself, for the three-way merge
// (utils/syncMerge.ts), tagged with the baseline hash it belongs to.
const SYNC_BASE_KEY = 'hrt-sync-base';
// Slow, event-driven sync (local storage is the primary copy; the cloud is a
// backup). No fast polling: each sync is one GET (+ one PUT when local changed).
//  - local edit        → push after PUSH_DEBOUNCE_MS of quiet (≤ PUSH_MAX_WAIT_MS)
//  - app hidden        → flush a pending push right away
//  - app shown / PWA resumed / back online → pull if the last pull is older
//                        than RESUME_PULL_MIN_MS
//  - while visible     → pull every PULL_INTERVAL_MS
const PULL_INTERVAL_MS = 15 * 60 * 1000;
const RESUME_PULL_MIN_MS = 60 * 1000;
const PUSH_DEBOUNCE_MS = 8 * 1000;
const PUSH_MAX_WAIT_MS = 60 * 1000;
const SCHEDULER_TICK_MS = 60 * 1000;
// Failed syncs (offline, 429, 5xx) retry on their own with exponential backoff
// (30 s, 1 min, 2 min, … up to 15 min); going online or reopening the app
// retries sooner. A 409 rerun is bounded per run.
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 15 * 60 * 1000;
const MAX_RERUNS_PER_RUN = 5;
const SYNC_LOCK_NAME = 'hrt-cloud-sync';
const isRetryable = (status: number) => status === 0 || status === 429 || status >= 500;
/** Window event other modules dispatch to request a sync (e.g. ownership resolved). */
export const SYNC_REQUEST_EVENT = 'hrt-sync-request';
/** Window event asking MainLayout to show the "whose data is this" choice again. */
export const OWNERSHIP_PROMPT_EVENT = 'hrt-ownership-prompt';

// Record the cloud baseline = the cloud state we last successfully synced with.
// This lets us distinguish "local-only changes since baseline" (safe to push) from
// "cloud changed under us while we also changed locally" (real conflict).
function setCloudBaseline(cloudUpdated: string | null | undefined, cloudHash: string, data: Record<string, any>, revision?: number) {
  if (cloudUpdated) {
    localStorage.setItem(LAST_KNOWN_CLOUD_UPDATED_KEY, cloudUpdated);
  }
  localStorage.setItem(LAST_KNOWN_CLOUD_HASH_KEY, cloudHash);
  try {
    localStorage.setItem(SYNC_BASE_KEY, JSON.stringify({ hash: cloudHash, data: pickMergeFields(data), revision }));
  } catch {
    // Quota: without a base the next divergence falls back to the conflict dialog.
    localStorage.removeItem(SYNC_BASE_KEY);
  }
}

function readStoredBase(): { data: Record<string, any>; revision?: number } | null {
  try {
    const stored = JSON.parse(localStorage.getItem(SYNC_BASE_KEY) || 'null');
    const hash = localStorage.getItem(LAST_KNOWN_CLOUD_HASH_KEY);
    return stored && hash && stored.hash === hash && stored.data ? stored : null;
  } catch {
    return null;
  }
}

/** The baseline's data, only if it still belongs to the current baseline hash. */
const readSyncBase = (): Record<string, any> | null => readStoredBase()?.data ?? null;

/** Server revision the baseline corresponds to (D1 backend), if known. */
const readSyncBaseRevision = (): number | undefined => {
  const revision = readStoredBase()?.revision;
  return typeof revision === 'number' ? revision : undefined;
};

// Deep-equal for comparing field values (handles arrays, objects, primitives)
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v: any, i: number) => deepEqual(v, b[i]));
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => keysB[i] === k && deepEqual(a[k], b[k]));
}

const SYNC_FIELDS = [
  'events', 'weight', 'labResults', 'lang',
  'calibrationModel', 'calibrationMode', 'applyE2LearningToCPA',
  'applyCPAInhibitionToE2', 'themeColor', 'themeMode',
  'gelProducts', 'bloodReports', 'regimens',
] as const;

function computeFieldDiffs(localData: Record<string, any>, cloudData: Record<string, any>): FieldDiff[] {
  // Normalize both sides through the shared projection so an absent field on one
  // side (e.g. an older client that never wrote gelProducts) compares equal to
  // the other side's default instead of producing a spurious diff.
  const lp = projectForSync(localData);
  const cp = projectForSync(cloudData);
  const diffs: FieldDiff[] = [];
  for (const field of SYNC_FIELDS) {
    if (!deepEqual(lp[field], cp[field])) {
      diffs.push({ field, localValue: lp[field], cloudValue: cp[field] });
    }
  }
  return diffs;
}

// Synced lists we refuse to clear silently: pulling an empty/absent cloud copy
// over a non-empty local list is treated as a conflict, not an auto-overwrite.
const PROTECTED_LIST_FIELDS = ['events', 'labResults', 'gelProducts', 'bloodReports', 'regimens'] as const;

function pullWouldClearLocalList(localData: Record<string, any>, cloudData: Record<string, any>): boolean {
  return PROTECTED_LIST_FIELDS.some((f) => {
    const lv = localData[f];
    const cv = cloudData[f];
    return Array.isArray(lv) && lv.length > 0 && (!Array.isArray(cv) || cv.length === 0);
  });
}

export const CloudSyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user, getSessionGeneration } = useAuth();
  const { hasSecurityPassword, isVerified, securityPassword, passwordVerificationFailed, checkSecurityPassword, invalidateUnlock } = useSecurityPassword();
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<ConflictState | null>(null);
  // Mirror of pendingConflict for instance-scoped cleanup: a stale resolver's
  // finally must never erase a NEW session's conflict modal (F02 re-review).
  const pendingConflictStateRef = useRef<ConflictState | null>(null);
  const updatePendingConflict = useCallback((next: ConflictState | null) => {
    pendingConflictStateRef.current = next;
    setPendingConflict(next);
  }, []);

  // Slow-sync scheduler state.
  const syncRunningRef = useRef(false);
  const syncRerunRef = useRef(false);
  // Status of the last failed request in the current run (0 = network), for
  // the backoff retry; null when the run did not fail.
  const failureStatusRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Revision of the cloud copy fetched by the current sync (baseline tagging).
  const pulledRevisionRef = useRef<number | undefined>(undefined);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushFirstRequestRef = useRef<number | null>(null);
  const isSyncingRef = useRef(false);
  const conflictPendingRef = useRef(false);
  // Live view of the authed account so post-await checks in async callbacks
  // compare against the CURRENT identity, not a stale closure (F02).
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // ── common guards ──
  // Why a sync cannot run right now: null = it can; 'busy' = one is running;
  // a 'sync.*' key = waiting on the user or the server (shown on the card).
  const blockReason = useCallback((): string | null => {
    if (!isAuthenticated || isLogoutInProgress()) return 'busy';
    // FINAL-REVIEW (blocker 1): while the ownership of the local records is
    // undecided (new account on a device holding someone else's data), nothing
    // moves — no pulls, pushes or conflict prompts.
    if (localStorage.getItem('hrt-data-ownership-pending') === '1') return 'sync.blockedOwnership';
    // Wait until we know whether the account has a security PIN (null =
    // still asking the server). Syncing before that sent no PIN and the
    // server answered "Invalid security password" on every app start.
    if (hasSecurityPassword === null) return 'sync.waitingPin';
    if (hasSecurityPassword && (!isVerified || passwordVerificationFailed || !securityPassword)) return 'sync.pinInvalid';
    if (conflictPendingRef.current) return 'sync.blockedConflict';
    if (isSyncingRef.current) return 'busy';
    return null;
  }, [isAuthenticated, hasSecurityPassword, isVerified, securityPassword, passwordVerificationFailed]);

  // Offline / busy get a friendly message and an automatic retry (runSync).
  const reportFailure = useCallback((status: number | undefined, error: string | undefined) => {
    const code = status ?? 0;
    // The unlock token expired or was revoked (another device chose "sign out
    // other devices"): show the PIN / passkey gate again.
    if (code === 403 && /security password/i.test(error || '')) invalidateUnlock();
    // 401 here means the access token could not be renewed just now (e.g. the
    // network was not back yet when the phone woke up); a failed renewal that
    // really ends the session logs out instead. Retry like an offline failure.
    failureStatusRef.current = code === 401 ? 0 : code;
    setSyncError(
      code === 401 ? 'sync.authRetry'
        : code === 0 ? 'sync.offline'
        : code === 429 || code >= 500 ? 'sync.busy'
        : /security password/i.test(error || '') ? 'sync.pinInvalid'
        // Anything else: keep the server's words plus the status, so a
        // screenshot is enough to tell what went wrong.
        : `${error || 'Sync failed'} (HTTP ${code})`,
    );
  }, [invalidateUnlock]);

  // ── getLocalDataSnapshot ──
  const getLocalDataSnapshot = useCallback(() => {
    const events = localStorage.getItem('hrt-events');
    const weight = localStorage.getItem('hrt-weight');
    const labResults = localStorage.getItem('hrt-lab-results');
    const lang = localStorage.getItem('hrt-lang');
    const calibrationModel = localStorage.getItem('hrt-calibration-model') || 'ekf';
    const calibrationMode = localStorage.getItem('hrt-calibration-mode') || 'retrospective';
    const applyE2Raw = localStorage.getItem('hrt-apply-e2-learning-to-cpa');
    const applyCPARaw = localStorage.getItem('hrt-apply-cpa-inhibition-to-e2');
    const themeColor = localStorage.getItem('hrt-theme-color') || 'sakura';
    const savedThemeMode = localStorage.getItem('hrt-theme-mode');
    const darkModeRaw = localStorage.getItem('hrt-dark-mode');
    const gelProductsRaw = localStorage.getItem('hrt-gel-products');
    const bloodReportsRaw = localStorage.getItem('hrt-blood-reports');
    const regimensRaw = localStorage.getItem('hrt-regimens');

    const storedLastModified = localStorage.getItem('hrt-last-modified');
    const storedLastDataUpdated = localStorage.getItem(LAST_DATA_UPDATED_KEY);
    // Parse defensively: a single corrupted localStorage entry (e.g. truncated by
    // a browser crash or quota eviction) must not throw out of this function — that
    // would make every subsequent sync silently fail with no user-visible signal.
    const safeParseArray = (raw: string | null): any[] => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const parsedEvents = safeParseArray(events);
    const parsedWeightRaw = weight ? parseFloat(weight) : DEFAULT_WEIGHT_KG;
    const parsedWeight = Number.isFinite(parsedWeightRaw) && parsedWeightRaw > 0
      ? parsedWeightRaw
      : DEFAULT_WEIGHT_KG;
    const parsedLabResults = safeParseArray(labResults);
    const resolvedLang = lang || 'en';
    const applyE2LearningToCPA = applyE2Raw === '1' || applyE2Raw?.toLowerCase() === 'true';
    const applyCPAInhibitionToE2 = applyCPARaw === '1' || applyCPARaw?.toLowerCase() === 'true';
    const darkMode = darkModeRaw === '1' || darkModeRaw === 'true';
    const themeMode = resolveThemeMode({ themeMode: savedThemeMode ?? undefined, darkMode });
    const gelProducts = safeParseArray(gelProductsRaw);
    const bloodReports = safeParseArray(bloodReportsRaw);
    const regimens = safeParseArray(regimensRaw);
    const dataHash = computeDataHash({
      events: parsedEvents,
      weight: parsedWeight,
      labResults: parsedLabResults,
      lang: resolvedLang,
      calibrationModel,
      calibrationMode,
      applyE2LearningToCPA,
      applyCPAInhibitionToE2,
      themeColor,
      themeMode,
      darkMode,
      gelProducts,
      bloodReports,
      regimens,
    });
    localStorage.setItem('hrt-data-hash', dataHash);

    return {
      events: parsedEvents,
      weight: parsedWeight,
      labResults: parsedLabResults,
      lang: resolvedLang,
      calibrationModel,
      calibrationMode,
      applyE2LearningToCPA,
      applyCPAInhibitionToE2,
      themeColor,
      themeMode,
      darkMode,
      gelProducts,
      bloodReports,
      regimens,
      lastModified: storedLastModified,
      lastDataUpdated: storedLastDataUpdated,
      dataHash,
    };
  }, []);

  // ── push (raw, no pull-check) ──
  const pushLocalDataToCloud = useCallback(async (localData: {
    events: any[];
    weight: number;
    labResults: any[];
    lang: string;
    calibrationModel?: string;
    calibrationMode?: string;
    applyE2LearningToCPA?: boolean;
    applyCPAInhibitionToE2?: boolean;
    themeColor?: string;
    themeMode?: string;
    darkMode?: boolean;
    gelProducts?: any[];
    bloodReports?: any[];
    regimens?: any[];
    lastModified: string;
    lastDataUpdated?: string | null;
  }, baseRevision?: number) => {
    // F02: stamp results only if the session that issued the push is still
    // current when the response arrives.
    const generation = getSessionGeneration();

    const response = await apiClient.updateUserData({
      data: {
        ...localData,
        lastDataUpdated: localData.lastDataUpdated || localData.lastModified,
      },
      password: hasSecurityPassword ? securityPassword : undefined,
      // Omitted for an explicit "keep this device's copy" (conflict dialog).
      base_revision: baseRevision,
    });

    if (getSessionGeneration() !== generation) {
      // Logged out / switched account mid-push: discard silently.
      return false;
    }

    if (response.success) {
      const now = new Date();
      const dataHash = computeDataHash({
        events: localData.events,
        weight: localData.weight,
        labResults: localData.labResults,
        lang: localData.lang,
        calibrationModel: localData.calibrationModel,
        calibrationMode: localData.calibrationMode,
        applyE2LearningToCPA: localData.applyE2LearningToCPA,
        applyCPAInhibitionToE2: localData.applyCPAInhibitionToE2,
        themeColor: localData.themeColor,
        themeMode: localData.themeMode,
        darkMode: localData.darkMode,
        gelProducts: localData.gelProducts,
        bloodReports: localData.bloodReports,
        regimens: localData.regimens,
      });
      setLastSyncTime(now);
      localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
      localStorage.setItem('hrt-last-modified', localData.lastModified);
      localStorage.setItem('hrt-data-hash', dataHash);
      if (localData.lastDataUpdated) {
        localStorage.setItem(LAST_DATA_UPDATED_KEY, localData.lastDataUpdated);
      }
      // After a successful push, the cloud's state == what we just uploaded,
      // so record it as the new baseline.
      setCloudBaseline(localData.lastDataUpdated || localData.lastModified, dataHash, localData,
        response.data?.revision);
      // The local data now matches THIS account's cloud copy (blocker 1).
      if (userRef.current?.username) {
        localStorage.setItem('hrt-data-owner', userRef.current.username);
      }
      return true;
    }

    if (response.status === 409) {
      // Another device uploaded since our pull: pull again and merge.
      syncRerunRef.current = true;
      return false;
    }
    reportFailure(response.status, response.error || 'Failed to sync to cloud');
    return false;
  }, [hasSecurityPassword, securityPassword, getSessionGeneration, reportFailure]);

  const shouldPullFromCloud = useCallback(() => {
    const lastPull = localStorage.getItem(LAST_PULL_TIME_KEY);
    if (!lastPull) return true;
    return Date.now() - new Date(lastPull).getTime() >= PULL_INTERVAL_MS;
  }, []);

  // Load last sync time from localStorage
  useEffect(() => {
    if (isAuthenticated) {
      const lastSync = localStorage.getItem(LAST_SYNC_TIME_KEY);
      if (lastSync) setLastSyncTime(new Date(lastSync));
    } else {
      setLastSyncTime(null);
    }
  }, [isAuthenticated]);

  // A pending conflict belongs to the session that raised it. On logout or
  // account switch it must not linger over the new session (F02).
  useEffect(() => {
    updatePendingConflict(null);
    conflictPendingRef.current = false;
  }, [isAuthenticated, user?.username, updatePendingConflict]);

  // ── apply cloud data to local ──
  // setBaseline=false: the written data is NOT what the cloud holds (local
  // edits on top of an uploaded merge), so the baseline stays as the upload set it.
  const applyCloudToLocal = useCallback((data: any, localData: Record<string, any>, fallbackTimestamp?: string, setBaseline = true) => {
    const resolvedLang = data?.lang || localData.lang;
    if (data?.events) localStorage.setItem('hrt-events', JSON.stringify(data.events));
    if (data?.weight !== undefined) localStorage.setItem('hrt-weight', data.weight.toString());
    if (data?.labResults) localStorage.setItem('hrt-lab-results', JSON.stringify(data.labResults));
    if (data?.lang) localStorage.setItem('hrt-lang', data.lang);
    if (data?.calibrationModel) localStorage.setItem('hrt-calibration-model', data.calibrationModel);
    if (data?.calibrationMode) localStorage.setItem('hrt-calibration-mode', data.calibrationMode);
    if (data?.applyE2LearningToCPA !== undefined) localStorage.setItem('hrt-apply-e2-learning-to-cpa', data.applyE2LearningToCPA ? '1' : '0');
    if (data?.applyCPAInhibitionToE2 !== undefined) localStorage.setItem('hrt-apply-cpa-inhibition-to-e2', data.applyCPAInhibitionToE2 ? '1' : '0');
    if (data?.themeColor) localStorage.setItem('hrt-theme-color', data.themeColor);
    // Resolve once so the value written to storage and the value folded into
    // the baseline hash below can never disagree.
    const resolvedThemeMode = data?.themeMode !== undefined || data?.darkMode !== undefined
      ? resolveThemeMode({ themeMode: data?.themeMode, darkMode: data?.darkMode })
      : localData.themeMode;
    if (resolvedThemeMode) localStorage.setItem('hrt-theme-mode', resolvedThemeMode);
    // The legacy flag is a mirror of the mode, never an independent field: a
    // conflict merge takes the mode from whichever side the user picked while
    // darkMode still rides along from the cloud copy, and the pair would be
    // pushed back out contradicting each other. Derive it here rather than
    // waiting for ThemeProvider - resolveConflict snapshots and uploads before
    // React can re-render, and since darkMode no longer feeds the hash, a
    // correction made afterwards would never be pushed. 'system' has no
    // device-independent answer, so record what this device actually shows,
    // which is what ThemeProvider will settle on a moment later.
    if (resolvedThemeMode) {
      const mirrorsDark = resolvedThemeMode === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : resolvedThemeMode === 'dark';
      localStorage.setItem('hrt-dark-mode', mirrorsDark ? '1' : '0');
    }
    if (data?.gelProducts !== undefined) localStorage.setItem('hrt-gel-products', JSON.stringify(data.gelProducts));
    if (data?.bloodReports !== undefined) localStorage.setItem('hrt-blood-reports', JSON.stringify(data.bloodReports));
    if (data?.regimens !== undefined) localStorage.setItem('hrt-regimens', JSON.stringify(data.regimens));
    if (data?.lastModified || fallbackTimestamp) localStorage.setItem('hrt-last-modified', data?.lastModified || fallbackTimestamp || '');
    if (data?.lastDataUpdated || fallbackTimestamp) localStorage.setItem(LAST_DATA_UPDATED_KEY, data?.lastDataUpdated || fallbackTimestamp || '');
    const dataHash = computeDataHash({
      events: data?.events || [],
      weight: data?.weight ?? localData.weight,
      labResults: data?.labResults || [],
      lang: resolvedLang,
      calibrationModel: data?.calibrationModel || localData.calibrationModel,
      calibrationMode: data?.calibrationMode || localData.calibrationMode,
      applyE2LearningToCPA: data?.applyE2LearningToCPA ?? localData.applyE2LearningToCPA,
      applyCPAInhibitionToE2: data?.applyCPAInhibitionToE2 ?? localData.applyCPAInhibitionToE2,
      themeColor: data?.themeColor || localData.themeColor,
      themeMode: resolvedThemeMode,
      darkMode: data?.darkMode ?? localData.darkMode,
      gelProducts: data?.gelProducts ?? localData.gelProducts,
      bloodReports: data?.bloodReports ?? localData.bloodReports,
      regimens: data?.regimens ?? localData.regimens,
    });
    localStorage.setItem('hrt-data-hash', dataHash);
    // After applying cloud data locally, our local state == cloud state,
    // so the cloud version we just pulled becomes the new baseline.
    if (setBaseline) setCloudBaseline(data?.lastDataUpdated || fallbackTimestamp || null, dataHash, data ?? {}, pulledRevisionRef.current);
    // The local data now matches THIS account's cloud copy (blocker 1).
    if (userRef.current?.username) {
      localStorage.setItem('hrt-data-owner', userRef.current.username);
    }
    window.dispatchEvent(new StorageEvent('storage', { key: 'hrt-data-synced', newValue: Date.now().toString() }));
  }, []);

  // FINAL-REVIEW (blocker 4): a 'cloud'/'merge' resolution replaces local
  // storage BEFORE the confirming upload. If that upload then fails, the
  // original local records must be restored — otherwise a later 'local'
  // resolution would read the overwritten storage and upload the cloud data
  // as if it were the user's own choice.
  const restoreLocalDataFromSnapshot = useCallback((snapshot: ReturnType<typeof getLocalDataSnapshot>, baseline: { updated: string | null; hash: string | null }) => {
    localStorage.setItem('hrt-events', JSON.stringify(snapshot.events));
    localStorage.setItem('hrt-weight', String(snapshot.weight));
    localStorage.setItem('hrt-lab-results', JSON.stringify(snapshot.labResults));
    localStorage.setItem('hrt-lang', snapshot.lang);
    localStorage.setItem('hrt-calibration-model', snapshot.calibrationModel);
    localStorage.setItem('hrt-calibration-mode', snapshot.calibrationMode);
    localStorage.setItem('hrt-apply-e2-learning-to-cpa', snapshot.applyE2LearningToCPA ? '1' : '0');
    localStorage.setItem('hrt-apply-cpa-inhibition-to-e2', snapshot.applyCPAInhibitionToE2 ? '1' : '0');
    localStorage.setItem('hrt-theme-color', snapshot.themeColor);
    localStorage.setItem('hrt-theme-mode', snapshot.themeMode);
    localStorage.setItem('hrt-dark-mode', snapshot.darkMode ? '1' : '0');
    localStorage.setItem('hrt-gel-products', JSON.stringify(snapshot.gelProducts ?? []));
    localStorage.setItem('hrt-blood-reports', JSON.stringify(snapshot.bloodReports ?? []));
    localStorage.setItem('hrt-regimens', JSON.stringify(snapshot.regimens ?? []));
    // Final-review follow-up: restore must also REMOVE keys the pre-apply
    // snapshot lacked — otherwise a failed cloud/merge resolution leaves the
    // applied cloud timestamps behind and retries use stale freshness state.
    if (snapshot.lastModified) localStorage.setItem('hrt-last-modified', snapshot.lastModified);
    else localStorage.removeItem('hrt-last-modified');
    if (snapshot.lastDataUpdated) localStorage.setItem(LAST_DATA_UPDATED_KEY, snapshot.lastDataUpdated);
    else localStorage.removeItem(LAST_DATA_UPDATED_KEY);
    localStorage.setItem('hrt-data-hash', snapshot.dataHash);
    if (baseline.updated) localStorage.setItem(LAST_KNOWN_CLOUD_UPDATED_KEY, baseline.updated);
    else localStorage.removeItem(LAST_KNOWN_CLOUD_UPDATED_KEY);
    if (baseline.hash) localStorage.setItem(LAST_KNOWN_CLOUD_HASH_KEY, baseline.hash);
    else localStorage.removeItem(LAST_KNOWN_CLOUD_HASH_KEY);
    // Same event applyCloudToLocal fires, so AppDataContext reloads React
    // state from the restored storage.
    window.dispatchEvent(new StorageEvent('storage', { key: 'hrt-data-synced', newValue: Date.now().toString() }));
  }, []);

  // ════════════════════════════════════════════════════════════
  //  UNIFIED SYNC — pull-before-push, conflict detection
  //  Called both by the 3-second poll AND by local-data-change.
  // ════════════════════════════════════════════════════════════
  const performSync = useCallback(async () => {
    const blocked = blockReason();
    if (blocked) {
      // Show why instead of a stale error from an earlier attempt.
      if (blocked !== 'busy') setSyncError(blocked);
      return;
    }

    // F02: bind this sync to the session (and account) that started it.
    const generation = getSessionGeneration();
    const username = userRef.current?.username ?? null;

    isSyncingRef.current = true;
    setIsSyncing(true);
    setSyncError(null);

    try {
      // ⓪ D1 backend: ask only for the revision first (no PIN, no download).
      //    Unchanged since our baseline → nothing to pull; a local edit is
      //    uploaded straight away, based on that revision.
      const knownRevision = CLOUD_BACKEND === 'd1' ? readSyncBaseRevision() : undefined;
      if (knownRevision !== undefined) {
        const probe = await apiClient.getUserDataRevision();
        if (getSessionGeneration() !== generation || (userRef.current?.username ?? null) !== username) return;
        if (!probe.success || !probe.data) {
          reportFailure(probe.status, probe.error || 'Failed to check cloud data');
          return;
        }
        if (probe.data.revision === knownRevision) {
          const local = getLocalDataSnapshot();
          if (local.dataHash !== localStorage.getItem(LAST_KNOWN_CLOUD_HASH_KEY)) {
            const stamp = new Date().toISOString();
            const pushed = await pushLocalDataToCloud({ ...local, lastModified: local.lastModified || stamp }, knownRevision);
            if (!pushed || getSessionGeneration() !== generation || (userRef.current?.username ?? null) !== username) return;
          }
          const now = new Date();
          setLastSyncTime(now);
          localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
          localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
          return;
        }
      }

      // ① Pull cloud data
      const response = await apiClient.getUserData({
        password: hasSecurityPassword ? securityPassword : undefined,
      });

      // The session that started this sync may be over (logout / account
      // switch) while the request was in flight. A stale response must never
      // touch local state, storage, conflict UI, sync baselines or sync time.
      if (getSessionGeneration() !== generation || (userRef.current?.username ?? null) !== username) {
        return;
      }

      const localData = getLocalDataSnapshot();
      const now = new Date();

      // F02 re-review: after ANY awaited push, stop dead if the session changed
      // — otherwise the stamp/baseline lines after the push would still run
      // for a sync whose session is over.
      // Uploads in this sync name the revision just pulled: if another device
      // uploads in between, the server refuses (409) and the sync reruns.
      const cloudRevision = typeof response.data?.revision === 'number' ? response.data.revision : undefined;
      pulledRevisionRef.current = cloudRevision;
      const pushAndStayCurrent = async (data: Parameters<typeof pushLocalDataToCloud>[0]): Promise<boolean> => {
        const pushed = await pushLocalDataToCloud(data, cloudRevision);
        // Final-review fix: the remote must explicitly confirm the upload
        // before we stamp sync time — a failed push returns false here so the
        // stamp lines after each call site are skipped.
        return pushed && getSessionGeneration() === generation && (userRef.current?.username ?? null) === username;
      };

      if (!response.success || !response.data) {
        // GET failed — DO NOT push: we have no idea what cloud actually contains,
        // and pushing blindly would set a stale baseline. The next 3-second poll
        // will retry once the network/auth recovers. Local changes remain in
        // localStorage and will be pushed on the next successful sync.
        reportFailure(response.status, response.error || 'Failed to fetch cloud data');
        return;
      }

      const cloudData = response.data.data;

      // ② No cloud data exists → push local
      if (!cloudData) {
        if (localData.lastModified) {
          if (!(await pushAndStayCurrent({ ...localData, lastModified: localData.lastModified }))) return;
        }
        setLastSyncTime(now);
        localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
        localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
        return;
      }

      // ③ Compare hashes
      const cloudHash = computeDataHash({
        events: cloudData.events || [],
        weight: cloudData.weight ?? localData.weight,
        labResults: cloudData.labResults || [],
        lang: cloudData.lang || localData.lang,
        calibrationModel: cloudData.calibrationModel || '',
        calibrationMode: cloudData.calibrationMode || '',
        applyE2LearningToCPA: cloudData.applyE2LearningToCPA ?? localData.applyE2LearningToCPA,
        applyCPAInhibitionToE2: cloudData.applyCPAInhibitionToE2 ?? localData.applyCPAInhibitionToE2,
        themeColor: cloudData.themeColor || localData.themeColor,
        themeMode: cloudData.themeMode !== undefined || cloudData.darkMode !== undefined
          ? resolveThemeMode({ themeMode: cloudData.themeMode, darkMode: cloudData.darkMode })
          : localData.themeMode,
        darkMode: cloudData.darkMode ?? localData.darkMode,
        gelProducts: cloudData.gelProducts || [],
        bloodReports: cloudData.bloodReports || [],
        regimens: cloudData.regimens || [],
      });

      if (cloudHash === localData.dataHash) {
        // Data identical — just sync the lastDataUpdated if missing
        if (!localData.lastDataUpdated && cloudData.lastDataUpdated) {
          localStorage.setItem(LAST_DATA_UPDATED_KEY, cloudData.lastDataUpdated);
        } else if (localData.lastDataUpdated && !cloudData.lastDataUpdated) {
          // Cloud lacks the field, push once so it's recorded
          if (!(await pushAndStayCurrent({ ...localData, lastModified: localData.lastModified || now.toISOString() }))) return;
        }
        // Local == cloud, refresh baseline so future pushes don't trip false conflicts
        setCloudBaseline(cloudData.lastDataUpdated || localData.lastDataUpdated || null, cloudHash, cloudData, cloudRevision);
        setLastSyncTime(now);
        localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
        localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
        return;
      }

      // ④ Data differs — distinguish "local-only changes since baseline" (push, no prompt)
      //    from "cloud changed under us while local also changed" (real conflict).
      const lastKnownCloudUpdated = localStorage.getItem(LAST_KNOWN_CLOUD_UPDATED_KEY);
      const lastKnownCloudHash = localStorage.getItem(LAST_KNOWN_CLOUD_HASH_KEY);
      const cloudDataUpdated = cloudData.lastDataUpdated as string | undefined;
      const localDataUpdated = localData.lastDataUpdated as string | null;

      // Classify whether each side changed since the baseline (pure, tested in
      // src/utils/syncDecision.test.ts — handles the hash-schema-evolution case).
      const { cloudChanged: cloudChangedSinceBaseline, localChanged: localChangedSinceBaseline } = classifyChanges({
        lastKnownCloudUpdated,
        lastKnownCloudHash,
        cloudDataUpdated,
        cloudHash,
        localHash: localData.dataHash,
        localLastModified: localData.lastModified,
        schemaPrefix: SYNC_HASH_SCHEMA,
      });

      // Pull cloud → local, but NEVER silently clear a non-empty local list with
      // an empty/absent cloud copy — escalate to a conflict instead. Used by every
      // pull path (incl. the step-⑤ fallback) so a stale-schema baseline that lands
      // in fallback can't route around the guard. Returns true if it escalated.
      const tryPull = (fallbackTs?: string): boolean => {
        if (pullWouldClearLocalList(localData, cloudData)) {
          const diffs = computeFieldDiffs(localData, cloudData);
          if (diffs.length > 0) {
            conflictPendingRef.current = true;
            updatePendingConflict({
              localData,
              cloudData,
              diffs,
              localTime: localDataUpdated || '',
              cloudTime: cloudDataUpdated || '',
              sessionGeneration: generation,
            });
            return true;
          }
        }
        applyCloudToLocal(cloudData, localData, fallbackTs);
        return false;
      };

      if (!cloudChangedSinceBaseline && localChangedSinceBaseline) {
        // Only local changed → safe to push without prompting
        if (!(await pushAndStayCurrent({
          ...localData,
          lastModified: localData.lastModified || now.toISOString(),
        }))) return;
        setLastSyncTime(now);
        localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
        localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
        return;
      }

      if (cloudChangedSinceBaseline && !localChangedSinceBaseline) {
        // Only cloud changed → pull, guarded against silently clearing local lists.
        if (tryPull()) return;
        setLastSyncTime(now);
        localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
        localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
        return;
      }

      if (cloudChangedSinceBaseline && localChangedSinceBaseline) {
        // Both sides diverged from the shared baseline. With the baseline's own
        // data at hand, merge record by record (utils/syncMerge.ts): additions,
        // edits and deletions from both devices are kept, and only the same
        // field edited on both sides is decided (for this device). Upload the
        // merge first; only once the server accepted it, write it locally.
        const base = readSyncBase();
        if (base) {
          const stamp = now.toISOString();
          const merged = {
            ...localData,
            ...mergeSnapshots(base, localData, cloudData),
            lastModified: stamp,
            lastDataUpdated: stamp,
          };
          if (!(await pushAndStayCurrent(merged))) return;
          // Edits made on this device while the upload was in flight are kept
          // on top of the merge and go out with the next sync.
          const latest = getLocalDataSnapshot();
          const editedMeanwhile = latest.dataHash !== localData.dataHash;
          applyCloudToLocal(
            editedMeanwhile ? { ...merged, ...mergeSnapshots(localData, latest, merged) } : merged,
            latest,
            undefined,
            !editedMeanwhile,
          );
          if (editedMeanwhile) syncRerunRef.current = true;
          setLastSyncTime(now);
          localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
          localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
          return;
        }
        // No usable baseline data (first sync after an upgrade, storage
        // quota): never auto-resolve by timestamp, ask the user.
        const diffs = computeFieldDiffs(localData, cloudData);
        if (diffs.length > 0) {
          conflictPendingRef.current = true;
          updatePendingConflict({
            localData,
            cloudData,
            diffs,
            localTime: localDataUpdated || '',
            cloudTime: cloudDataUpdated || '',
            sessionGeneration: generation,
          });
        }
        return;
      }
      // else: !cloudChanged && !localChanged yet hash differs — shouldn't happen
      // after baseline is set (step ③ would have matched). Fall through for safety.

      // ⑤ Fallback: only reached when no baseline exists yet AND step ④ couldn't decide
      // (e.g. !localChanged && !cloudChanged but hashes differ — extremely rare).
      // Use lastModified to pick a winner conservatively, then establish a baseline.
      const cloudLM = cloudData.lastModified as string | undefined;
      const localLM = localData.lastModified;

      if (cloudLM && localLM) {
        if (new Date(localLM) > new Date(cloudLM)) {
          if (!(await pushAndStayCurrent(localData))) return;
        } else {
          // Cloud newer, or equal lastModified with different hashes — prefer cloud,
          // but guard against silently clearing local lists (escalates to conflict).
          if (tryPull()) return;
        }
      } else if (!cloudLM && localLM) {
        if (!(await pushAndStayCurrent({ ...localData, lastModified: localLM }))) return;
      } else if (cloudLM && !localLM) {
        if (tryPull()) return;
      } else {
        // Neither has timestamps — prefer cloud (server-authoritative on cold start),
        // still guarded so a cold-start pull can't wipe non-empty local lists.
        if (tryPull(now.toISOString())) return;
      }

      setLastSyncTime(now);
      localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
      localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
    } catch (error) {
      console.error('Sync error:', error);
      reportFailure(0, error instanceof Error ? error.message : 'Sync failed');
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [blockReason, hasSecurityPassword, securityPassword, getLocalDataSnapshot, pushLocalDataToCloud, applyCloudToLocal, getSessionGeneration, updatePendingConflict, reportFailure]);

  // ── Resolve conflict ──
  const resolveConflict = useCallback(async (
    resolution: 'local' | 'cloud' | 'merge',
    mergedData?: Record<string, any>,
  ) => {
    if (!pendingConflictStateRef.current) return;

    // F02: a conflict resolution belongs to the session that raised it AND to
    // the exact conflict instance it resolves.
    const generation = getSessionGeneration();
    const conflict = pendingConflictStateRef.current;
    const { localData, cloudData } = conflict;
    const now = new Date().toISOString();

    // Entry guard: the session may have changed while the dialog sat open
    // (e.g. same-account re-login bumps the generation without the auth-change
    // effect firing). A resolution raised by another session is ignored.
    if (conflict.sessionGeneration !== undefined && conflict.sessionGeneration !== generation) {
      return;
    }

    // Singleton lock: a rapid second resolution must not run concurrently with
    // the first (its finally would release the lock the other resolver needs).
    if (isSyncingRef.current) {
      return;
    }

    // True while this resolver still owns the conflict UI and the sync lock.
    let current = true;
    // F10: the remote must explicitly confirm the upload before we stamp sync
    // time or close the dialog — a failed push keeps the conflict open and
    // retryable instead of masquerading as success.
    let pushed = false;

    try {
      isSyncingRef.current = true;
      setIsSyncing(true);

      if (resolution === 'local') {
        // Snapshot again rather than reusing the one captured when the conflict
        // was raised: the dialog can sit open for a while, and under the
        // 'system' display mode the derived dark flag changes on its own when
        // the OS theme flips. The cloud and merge branches already re-read.
        const currentLocal = getLocalDataSnapshot();
        pushed = await pushLocalDataToCloud({ ...currentLocal, lastModified: now, lastDataUpdated: now });
        current = getSessionGeneration() === generation;
        if (current && pushed) {
          localStorage.setItem('hrt-last-modified', now);
          localStorage.setItem(LAST_DATA_UPDATED_KEY, now);
        }
      } else if (resolution === 'cloud') {
        // Apply locally ONLY if this resolver is still current — the check and
        // the apply run with no await between them, so a stale resolver can
        // never write old-session data into local storage (F02 re-review).
        current = getSessionGeneration() === generation;
        if (!current) return;
        const preApplyLocal = getLocalDataSnapshot();
        const preBaseline = {
          updated: localStorage.getItem(LAST_KNOWN_CLOUD_UPDATED_KEY),
          hash: localStorage.getItem(LAST_KNOWN_CLOUD_HASH_KEY),
        };
        applyCloudToLocal({ ...cloudData, lastModified: now, lastDataUpdated: now }, localData);
        localStorage.setItem('hrt-last-modified', now);
        localStorage.setItem(LAST_DATA_UPDATED_KEY, now);
        const updatedLocal = getLocalDataSnapshot();
        pushed = await pushLocalDataToCloud({ ...updatedLocal, lastModified: now, lastDataUpdated: now });
        current = getSessionGeneration() === generation;
        if (current && !pushed) {
          // Upload failed: bring the original local records back (blocker 4).
          restoreLocalDataFromSnapshot(preApplyLocal, preBaseline);
        }
      } else if (resolution === 'merge' && mergedData) {
        current = getSessionGeneration() === generation;
        if (!current) return;
        const preApplyLocal = getLocalDataSnapshot();
        const preBaseline = {
          updated: localStorage.getItem(LAST_KNOWN_CLOUD_UPDATED_KEY),
          hash: localStorage.getItem(LAST_KNOWN_CLOUD_HASH_KEY),
        };
        applyCloudToLocal({ ...mergedData, lastModified: now, lastDataUpdated: now }, localData);
        localStorage.setItem('hrt-last-modified', now);
        localStorage.setItem(LAST_DATA_UPDATED_KEY, now);
        const updatedLocal = getLocalDataSnapshot();
        pushed = await pushLocalDataToCloud({ ...updatedLocal, lastModified: now, lastDataUpdated: now });
        current = getSessionGeneration() === generation;
        if (current && !pushed) {
          // Upload failed: bring the original local records back (blocker 4).
          restoreLocalDataFromSnapshot(preApplyLocal, preBaseline);
        }
      }

      if (!current) {
        // Session changed while resolving — skip all stamps; the finally
        // block still releases the conflict/sync locks.
        return;
      }
      if (!pushed) {
        // F10: upload failed (pushLocalDataToCloud already set syncError). Do
        // NOT stamp sync time or close the dialog — the user keeps their
        // choice and can retry. (For cloud/merge the local copy was already
        // applied; the next sync will re-detect the divergence.)
        return;
      }
      const syncNow = new Date();
      setLastSyncTime(syncNow);
      localStorage.setItem(LAST_SYNC_TIME_KEY, syncNow.toISOString());
      localStorage.setItem(LAST_PULL_TIME_KEY, syncNow.toISOString());
    } catch (error) {
      console.error('Conflict resolution error:', error);
      setSyncError(error instanceof Error ? error.message : 'Failed to resolve conflict');
    } finally {
      // Instance-scoped cleanup: only clear the conflict UI if it is still
      // THIS resolver's conflict — a stale finally must never erase a new
      // session's conflict modal (F02 re-review), and a FAILED push must not
      // close the dialog either (F10: keep the user's choice retryable).
      // The sync lock is a singleton this operation holds, so it is always
      // released.
      if (pushed && pendingConflictStateRef.current === conflict) {
        updatePendingConflict(null);
        conflictPendingRef.current = false;
      }
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [pushLocalDataToCloud, applyCloudToLocal, getLocalDataSnapshot, getSessionGeneration, updatePendingConflict, restoreLocalDataFromSnapshot]);

  // ── Slow-sync scheduler ──
  // Serialises syncs: a request arriving while one runs is not dropped — it
  // triggers exactly one more run afterwards (performSync itself bails out
  // while another sync is in flight).
  //
  // Across tabs/windows of the app, a Web Lock lets only one sync run at a
  // time (as AtDo's outbox does), so two tabs never race each other's upload.
  const runSyncRef = useRef<() => void>(() => {});
  const runSync = useCallback(async () => {
    if (syncRunningRef.current) { syncRerunRef.current = true; return; }
    syncRunningRef.current = true;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    try {
      const body = async () => {
        let runs = 0;
        do {
          syncRerunRef.current = false;
          failureStatusRef.current = null;
          await performSync();
        } while (syncRerunRef.current && ++runs < MAX_RERUNS_PER_RUN);
      };
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      if (locks) await locks.request(SYNC_LOCK_NAME, body);
      else await body();
    } finally {
      syncRunningRef.current = false;
    }
    const failed = failureStatusRef.current;
    if (failed !== null && isRetryable(failed) && isAuthenticated && !isLogoutInProgress()) {
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retryAttemptRef.current);
      retryAttemptRef.current += 1;
      retryTimerRef.current = setTimeout(() => runSyncRef.current(), delay);
    } else if (failed === null) {
      retryAttemptRef.current = 0;
    }
  }, [performSync, isAuthenticated]);
  runSyncRef.current = runSync;

  const flushPush = useCallback(() => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = null;
    pushFirstRequestRef.current = null;
    runSync();
  }, [runSync]);

  // Debounced push: coalesce bursts of edits into one upload.
  const schedulePush = useCallback(() => {
    const now = Date.now();
    if (pushFirstRequestRef.current === null) pushFirstRequestRef.current = now;
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    const waited = now - pushFirstRequestRef.current;
    const delay = Math.max(0, Math.min(PUSH_DEBOUNCE_MS, PUSH_MAX_WAIT_MS - waited));
    pushTimerRef.current = setTimeout(flushPush, delay);
  }, [flushPush]);

  // Manual "back up now": also clears whatever is holding sync back that a
  // tap can fix — ask the PIN status again, or reopen the ownership choice.
  const syncNow = useCallback(() => {
    retryAttemptRef.current = 0;
    const blocked = blockReason();
    if (blocked === 'sync.waitingPin') {
      checkSecurityPassword();
    } else if (blocked === 'sync.blockedOwnership') {
      window.dispatchEvent(new CustomEvent(OWNERSHIP_PROMPT_EVENT));
    }
    flushPush();
  }, [flushPush, blockReason, checkSecurityPassword]);

  useEffect(() => {
    if (!isAuthenticated || isLogoutInProgress()) return;

    const onLocalUpdate = () => schedulePush();
    // Another tab changed synced storage: that tab syncs its own edit; we only
    // need a (debounced) check so this tab's baseline stays current.
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage) return;
      const syncKeys = ['hrt-events', 'hrt-weight', 'hrt-lab-results', 'hrt-lang', 'hrt-calibration-model', 'hrt-calibration-mode', 'hrt-apply-e2-learning-to-cpa', 'hrt-apply-cpa-inhibition-to-e2', 'hrt-theme-color', 'hrt-theme-mode', 'hrt-dark-mode', 'hrt-gel-products', 'hrt-blood-reports', 'hrt-regimens'];
      if (e.key && syncKeys.includes(e.key)) schedulePush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // Leaving / backgrounding the app (incl. an installed PWA): upload now.
        if (pushTimerRef.current) flushPush();
      } else {
        // Shown again / PWA resumed: pull if it has been a while.
        const lastPull = localStorage.getItem(LAST_PULL_TIME_KEY);
        if (!lastPull || Date.now() - new Date(lastPull).getTime() >= RESUME_PULL_MIN_MS) runSync();
      }
    };
    const onOnline = () => { retryAttemptRef.current = 0; runSync(); };
    const onRequest = () => flushPush();

    window.addEventListener('hrt-local-data-updated', onLocalUpdate as EventListener);
    window.addEventListener('storage', onStorage);
    window.addEventListener('online', onOnline);
    window.addEventListener(SYNC_REQUEST_EVENT, onRequest);
    document.addEventListener('visibilitychange', onVisibility);

    // Initial sync on mount / auth change, then a slow periodic pull while visible.
    runSync();
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible' && shouldPullFromCloud()) runSync();
    }, SCHEDULER_TICK_MS);

    return () => {
      window.removeEventListener('hrt-local-data-updated', onLocalUpdate as EventListener);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', onOnline);
      window.removeEventListener(SYNC_REQUEST_EVENT, onRequest);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(tick);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      retryAttemptRef.current = 0;
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      pushTimerRef.current = null;
      pushFirstRequestRef.current = null;
    };
  }, [isAuthenticated, runSync, schedulePush, flushPush, shouldPullFromCloud]);

  // Sync becomes possible later — the PIN status arrived (no PIN), or the
  // PIN was verified: run once then.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (hasSecurityPassword === false || (hasSecurityPassword && isVerified && securityPassword)) runSync();
  }, [isAuthenticated, hasSecurityPassword, isVerified, securityPassword, runSync]);

  return (
    <CloudSyncContext.Provider
      value={{ isSyncing, lastSyncTime, syncError, pendingConflict, resolveConflict, syncNow }}
    >
      {children}
    </CloudSyncContext.Provider>
  );
};

export const useCloudSync = () => {
  const context = useContext(CloudSyncContext);
  if (!context) throw new Error('useCloudSync must be used within a CloudSyncProvider');
  return context;
};
