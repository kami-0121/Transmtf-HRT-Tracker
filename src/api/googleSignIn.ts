import apiClient from './client';

/**
 * Starts Google sign-in (D1 backend): fetches the authorization URL, remembers
 * `state` for OIDCCallback and leaves the page. Resolves with an error message
 * only when the redirect could not start.
 */
export async function startGoogleSignIn(): Promise<string | null> {
    const response = await apiClient.getOIDCAuthorizeUrl();
    if (!response.success || !response.data) return response.error || 'Failed to start sign-in';
    sessionStorage.setItem('oidc_state', response.data.state);
    sessionStorage.setItem('oidc_action', 'login');
    window.location.href = response.data.auth_url;
    return null;
}

let availability: Promise<boolean> | null = null;

/** Whether the server has Google sign-in configured (asked once per page load). */
export function googleSignInAvailable(): Promise<boolean> {
    if (!availability) {
        availability = apiClient.getOIDCConfig()
            .then(r => !!(r.success && r.data?.oidc_enabled))
            .catch(() => true);   // unknown (offline): keep the button, the click reports errors
    }
    return availability;
}
