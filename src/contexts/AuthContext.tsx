import { CLOUD_ENABLED, CLOUD_BACKEND } from '../api/config';
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import apiClient from '../api/client';
import type { AuthTokens, UpdateProfileRequest, UserProfile } from '../api/types';
import { clearSecurityPassword } from '../utils/crypto';
import { deleteCookie, getCookie, setCookie } from '../utils/cookies';
import { setLogoutInProgress } from '../utils/authSessionState';
import { clearAllLocalMedicalData, hasLocalMedicalData } from '../utils/localDataCleanup';

interface User {
  username: string;
  displayName?: string;
  avatarUrl?: string;
  /** D1 backend: a custom avatar is set (otherwise avatarUrl is the Google photo). */
  hasCustomAvatar?: boolean;
  /** D1 backend: the Google photo, shown when no custom avatar is set. */
  googleAvatarUrl?: string;
  /** D1 backend: greet the user by name on the overview. */
  greet?: boolean;
}

interface AuthContextType {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isLoggingOut: boolean;
  login: (username: string, password: string, turnstileToken?: string) => Promise<{ success: boolean; error?: string; status?: number }>;
  register: (username: string, password: string, turnstileToken?: string) => Promise<{ success: boolean; error?: string }>;
  loginWithTokens: (tokens: AuthTokens, username: string, displayName?: string, avatarUrl?: string) => void;
  logout: (clearLocalData?: boolean) => Promise<void>;
  refreshAccessToken: () => Promise<boolean>;
  /** Live session generation; increments on every login/logout/account switch. Async tasks capture it to detect stale sessions. */
  getSessionGeneration: () => number;
  /** D1 backend: save display name / avatar / greeting; resolves with an error message on failure. */
  updateProfile: (patch: UpdateProfileRequest) => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_STORAGE_KEY = 'hrt-access-token';
const REFRESH_TOKEN_STORAGE_KEY = 'hrt-refresh-token';
const USERNAME_STORAGE_KEY = 'hrt-username';
const DISPLAY_NAME_STORAGE_KEY = 'hrt-display-name';
const AVATAR_URL_STORAGE_KEY = 'hrt-avatar-url';
const TOKEN_COOKIE_DAYS = 3650;
// Profile (name, avatar, greeting) cached for instant display; the server
// copy wins. localStorage, not a cookie: a custom avatar is a data URL far
// larger than a cookie may be.
const PROFILE_STORAGE_KEY = 'hrt-profile';

const readStoredProfile = (): Partial<User> => {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
};
const storeProfile = (profile: Partial<User>) => {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Quota: the profile is simply fetched again next time.
  }
};
const profileFields = (p: UserProfile): Partial<User> => ({
  displayName: p.display_name,
  avatarUrl: p.avatar_url ?? undefined,
  hasCustomAvatar: p.has_custom_avatar,
  googleAvatarUrl: p.google_avatar_url ?? undefined,
  greet: p.greet,
});

/**
 * Token Storage Strategy:
 *
 * We store auth tokens in cookies (not localStorage) to reduce XSS attack surface.
 * However, these are JavaScript-set cookies and NOT HttpOnly, so they can still
 * be accessed by malicious scripts.
 *
 * See src/utils/cookies.ts for detailed security notes and recommendations.
 */

const getStoredValue = (key: string) => getCookie(key);
const setStoredValue = (key: string, value: string) => {
  setCookie(key, value, TOKEN_COOKIE_DAYS);
};
const clearStoredValue = (key: string) => {
  deleteCookie(key);
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const refreshPromiseRef = React.useRef<Promise<boolean> | null>(null);
  // Increments on every session boundary (login/register/loginWithTokens/logout).
  // In-flight async auth tasks capture the current value and must re-verify it
  // before writing tokens, cookies or React state, so a stale response from a
  // previous account/session can never overwrite the new one (F18).
  const sessionGenerationRef = React.useRef(0);
  const getSessionGeneration = useCallback(() => sessionGenerationRef.current, []);

  const logout = useCallback(async (clearLocalData: boolean = false) => {
    if (isLoggingOut) {
      return;
    }

    const tokenToRevoke = accessToken || getStoredValue(TOKEN_STORAGE_KEY);
    // Capture the account being logged out BEFORE its username cookie is
    // cleared, so the security-password cleanup can target that user's
    // namespaced cookie only (F18: never clear another account's PIN cookie).
    const usernameToClear = getStoredValue(USERNAME_STORAGE_KEY);

    // Invalidate any in-flight refresh for the session being torn down.
    sessionGenerationRef.current += 1;
    // Capture this logout's generation: every post-await cleanup step below
    // must verify it is still current, so a new login (B) cannot be clobbered
    // by the tail of A's logout (F18).
    const generation = sessionGenerationRef.current;
    refreshPromiseRef.current = null;
    // Abort in-flight API requests (sync pulls/pushes) so their results can
    // never land after this session ends (F02).
    apiClient.cancelInflightRequests();

    setIsLoggingOut(true);
    setLogoutInProgress(true);

    setAccessToken(null);
    setUser(null);
    apiClient.setAccessToken(null);

    // Always clear auth tokens before touching local data so sync can no longer authenticate.
    clearStoredValue(TOKEN_STORAGE_KEY);
    clearStoredValue(REFRESH_TOKEN_STORAGE_KEY);
    clearStoredValue(USERNAME_STORAGE_KEY);
    clearStoredValue(DISPLAY_NAME_STORAGE_KEY);
    clearStoredValue(AVATAR_URL_STORAGE_KEY);
    localStorage.removeItem(PROFILE_STORAGE_KEY);

    // FINAL-REVIEW FIX (blocker 1): the local wipe happens SYNCHRONOUSLY,
    // BEFORE any network call. Previously it sat behind `await
    // apiClient.logout(...)`, so a new login landing during that wait made the
    // generation guard skip the clear entirely — "clear on logout" silently
    // kept the data.
    if (clearLocalData) {
      clearAllLocalMedicalData();
    }

    try {
      try {
        if (tokenToRevoke) {
          await apiClient.logout(tokenToRevoke);
        }
      } catch (error) {
        console.error('Failed to logout from server:', error);
      }

      // A login / account switch may have started while the server logout was
      // in flight. A's remaining cleanup must never hit B's session (F18).
      if (sessionGenerationRef.current !== generation) {
        return;
      }

      // Always clear security password cookie (this user's namespaced one, plus
      // the legacy shared blob only if it belongs to this user).
      try {
        await clearSecurityPassword(usernameToClear ?? undefined);
      } catch (error) {
        console.error('Failed to clear security password during logout:', error);
      }
    } finally {
      setLogoutInProgress(false);
      setIsLoggingOut(false);
    }
  }, [accessToken, isLoggingOut]);

  const refreshAccessToken = useCallback(async (): Promise<boolean> => {
    // Prevent multiple simultaneous refresh attempts
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    // Capture which session this refresh belongs to; results are only applied
    // if the session (and account) is unchanged when the response arrives.
    const generation = sessionGenerationRef.current;
    const sessionUsername = getStoredValue(USERNAME_STORAGE_KEY);
    const refreshToken = getStoredValue(REFRESH_TOKEN_STORAGE_KEY);
    if (!refreshToken) return false;

    // NOTE: checked synchronously above so the IIFE body always reaches an
    // await — otherwise its `finally` would run before `promise` is assigned
    // (TDZ ReferenceError) when there is no refresh token.
    const promise = (async () => {
      try {
        const response = await apiClient.refreshToken({ refresh_token: refreshToken });

        // Stale session (logged out or switched account): never apply old results.
        if (sessionGenerationRef.current !== generation || getStoredValue(USERNAME_STORAGE_KEY) !== sessionUsername) {
          return false;
        }

        if (response.success && response.data) {
          const { access_token, refresh_token } = response.data;
          setAccessToken(access_token);
          apiClient.setAccessToken(access_token);
          setStoredValue(TOKEN_STORAGE_KEY, access_token);
          setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
          return true;
        }

        if (response.status === 401) {
          // Refresh token is invalid/expired - logout (only if still our session)
          if (sessionGenerationRef.current === generation) {
            logout();
          }
        } else {
          console.warn('Refresh token failed, keeping session for retry:', response.error);
        }
        return false;
      } finally {
        if (refreshPromiseRef.current === promise) {
          refreshPromiseRef.current = null;
        }
      }
    })();

    refreshPromiseRef.current = promise;
    return promise;
  }, [logout, getSessionGeneration]);

  // Initialize auth state from cookies, with silent refresh fallback
  useEffect(() => {
    // Local-only deployment: never restore a session (no refresh request).
    if (!CLOUD_ENABLED) {
      setIsLoading(false);
      return;
    }
    const storedAccessToken = getStoredValue(TOKEN_STORAGE_KEY);
    const storedUsername = getStoredValue(USERNAME_STORAGE_KEY);
    const storedRefreshToken = getStoredValue(REFRESH_TOKEN_STORAGE_KEY);

    if (storedAccessToken && storedUsername) {
      // Access token present — restore session immediately
      const storedDisplayName = getStoredValue(DISPLAY_NAME_STORAGE_KEY) || undefined;
      const storedAvatarUrl = getStoredValue(AVATAR_URL_STORAGE_KEY) || undefined;
      setAccessToken(storedAccessToken);
      setUser({ username: storedUsername, displayName: storedDisplayName, avatarUrl: storedAvatarUrl, ...readStoredProfile() });
      apiClient.setAccessToken(storedAccessToken);
      setIsLoading(false);
    } else if (storedRefreshToken && storedUsername) {
      // No access token (expired / cleared) but refresh token exists — try silent refresh
      // Keep isLoading=true until refresh completes so ProtectedRoute doesn't flash /login
      const generation = sessionGenerationRef.current;
      apiClient.refreshToken({ refresh_token: storedRefreshToken }).then((response) => {
        // A login/logout started while the refresh was in flight — discard the stale result.
        if (sessionGenerationRef.current !== generation) {
          setIsLoading(false);
          return;
        }
        if (response.success && response.data) {
          const { access_token, refresh_token } = response.data;
          const storedDisplayName = getStoredValue(DISPLAY_NAME_STORAGE_KEY) || undefined;
          const storedAvatarUrl = getStoredValue(AVATAR_URL_STORAGE_KEY) || undefined;
          setAccessToken(access_token);
          setUser({ username: storedUsername, displayName: storedDisplayName, avatarUrl: storedAvatarUrl, ...readStoredProfile() });
          apiClient.setAccessToken(access_token);
          setStoredValue(TOKEN_STORAGE_KEY, access_token);
          setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
        } else {
          // Refresh token also invalid — clear all stored tokens
          clearStoredValue(TOKEN_STORAGE_KEY);
          clearStoredValue(REFRESH_TOKEN_STORAGE_KEY);
          clearStoredValue(USERNAME_STORAGE_KEY);
        }
        setIsLoading(false);
      }).catch(() => {
        // Network error during startup refresh — keep tokens, let user retry later
        setIsLoading(false);
      });
    } else {
      setIsLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Set refresh token callback
  useEffect(() => {
    apiClient.setRefreshTokenCallback(refreshAccessToken);
  }, [refreshAccessToken]);

  // Set up token refresh interval (every 50 minutes while tab is active)
  useEffect(() => {
    if (!accessToken) return;

    // Refresh token every 50 minutes (tokens expire in 1 hour)
    const refreshInterval = setInterval(() => {
      refreshAccessToken();
    }, 50 * 60 * 1000);

    return () => clearInterval(refreshInterval);
    // Only re-run when accessToken changes, not when refreshAccessToken changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // Re-validate session when the page becomes visible again (e.g. mobile app resume)
  useEffect(() => {
    if (!accessToken) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Page was hidden (background / sleep) and is now active again.
        // Proactively refresh the access token so that a stale JWT doesn't
        // cause the very next API call to get a 401 and trigger a forced logout.
        refreshAccessToken();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // FINAL-REVIEW (blocker 1): the local records belong to whoever's data they
  // are. If they were never synced under THIS account, block all cloud sync
  // until the user explicitly decides (upload vs clear) — otherwise the new
  // account's first sync would push the previous account's retained records
  // into the new account's cloud.
  const updateDataOwnershipFlag = (username: string) => {
    const owner = localStorage.getItem('hrt-data-owner');
    if (hasLocalMedicalData() && owner !== username) {
      localStorage.setItem('hrt-data-ownership-pending', '1');
    } else {
      localStorage.removeItem('hrt-data-ownership-pending');
    }
  };

  const login = async (username: string, password: string, turnstileToken?: string) => {
    const response = await apiClient.login({
      username,
      password,
      turnstile_token: turnstileToken
    });

    if (response.success && response.data) {
      const { access_token, refresh_token } = response.data;

      // New session: invalidate any in-flight auth tasks from a previous session.
      sessionGenerationRef.current += 1;
      refreshPromiseRef.current = null;
      apiClient.cancelInflightRequests();

      setAccessToken(access_token);
      setUser({ username });
      apiClient.setAccessToken(access_token);

      setStoredValue(TOKEN_STORAGE_KEY, access_token);
      setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
      setStoredValue(USERNAME_STORAGE_KEY, username);
      updateDataOwnershipFlag(username);

      return { success: true };
    }

    return { success: false, error: response.error || 'Login failed', status: response.status };
  };

  const register = async (username: string, password: string, turnstileToken?: string) => {
    const response = await apiClient.register({
      username,
      password,
      turnstile_token: turnstileToken
    });

    if (response.success && response.data) {
      const { access_token, refresh_token } = response.data;

      // New session: invalidate any in-flight auth tasks from a previous session.
      sessionGenerationRef.current += 1;
      refreshPromiseRef.current = null;
      apiClient.cancelInflightRequests();

      setAccessToken(access_token);
      setUser({ username });
      apiClient.setAccessToken(access_token);

      setStoredValue(TOKEN_STORAGE_KEY, access_token);
      setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
      setStoredValue(USERNAME_STORAGE_KEY, username);
      updateDataOwnershipFlag(username);

      return { success: true };
    }

    return { success: false, error: response.error || 'Registration failed' };
  };

  const loginWithTokens = (tokens: AuthTokens, username: string, displayName?: string, avatarUrl?: string) => {
    const { access_token, refresh_token } = tokens;

    // New session: invalidate any in-flight auth tasks from a previous session.
    sessionGenerationRef.current += 1;
    refreshPromiseRef.current = null;
    apiClient.cancelInflightRequests();

    setAccessToken(access_token);
    setUser({ username, displayName, avatarUrl });
    storeProfile({ displayName, avatarUrl });
    apiClient.setAccessToken(access_token);

    setStoredValue(TOKEN_STORAGE_KEY, access_token);
    setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
    setStoredValue(USERNAME_STORAGE_KEY, username);
    if (displayName) setStoredValue(DISPLAY_NAME_STORAGE_KEY, displayName);
    else clearStoredValue(DISPLAY_NAME_STORAGE_KEY);
    // Always use OAuth avatar URL; clear any previously stored local avatar
    if (avatarUrl) setStoredValue(AVATAR_URL_STORAGE_KEY, avatarUrl);
    else clearStoredValue(AVATAR_URL_STORAGE_KEY);
    updateDataOwnershipFlag(username);
  };

  // D1 backend: pull the current profile once a session is up (it may have
  // been edited on another device).
  const sessionUsername = user?.username;
  useEffect(() => {
    if (CLOUD_BACKEND !== 'd1' || !accessToken || !sessionUsername) return;
    const generation = sessionGenerationRef.current;
    apiClient.getMe().then((response) => {
      if (sessionGenerationRef.current !== generation || !response.success || !response.data?.display_name) return;
      const fields = profileFields(response.data as UserProfile);
      storeProfile(fields);
      setUser((current) => (current ? { ...current, ...fields } : current));
    });
  }, [accessToken, sessionUsername]);

  const updateProfile = useCallback(async (patch: UpdateProfileRequest): Promise<string | null> => {
    const generation = sessionGenerationRef.current;
    const response = await apiClient.updateProfile(patch);
    if (sessionGenerationRef.current !== generation) return 'Session changed';
    if (!response.success || !response.data) return response.error || 'Failed to save profile';
    const fields = profileFields(response.data);
    storeProfile(fields);
    setUser((current) => (current ? { ...current, ...fields } : current));
    return null;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        isAuthenticated: !!user && !!accessToken,
        isLoading,
        isLoggingOut,
        login,
        register,
        loginWithTokens,
        logout,
        refreshAccessToken,
        getSessionGeneration,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
