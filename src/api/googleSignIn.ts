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
