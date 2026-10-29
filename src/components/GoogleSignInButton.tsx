import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { startGoogleSignIn, googleSignInAvailable } from '../api/googleSignIn';

// Google's multicolour "G" (brand guidelines: white button, logo on the left).
const GoogleLogo = () => (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
);

const GoogleSignInButton: React.FC<{ onError?: (message: string) => void }> = ({ onError }) => {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(false);
    // null = still asking the server; false = the Worker has no Google credentials.
    const [available, setAvailable] = useState<boolean | null>(null);
    useEffect(() => {
        let alive = true;
        googleSignInAvailable().then(ok => { if (alive) setAvailable(ok); });
        return () => { alive = false; };
    }, []);
    const start = async () => {
        setLoading(true);
        const error = await startGoogleSignIn();
        if (error) {
            setLoading(false);
            onError?.(/not configured/i.test(error) ? t('login.googleNotConfigured') : error);
        }
    };
    if (available === false) {
        return (
            <div className="rounded-xl border px-3 py-2.5 text-xs sm:text-sm text-center" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                {t('login.googleNotConfigured')}
            </div>
        );
    }
    return (
        <button
            type="button"
            onClick={start}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 border py-3 px-4 rounded-xl font-medium transition disabled:opacity-60 disabled:cursor-not-allowed text-sm sm:text-base btn-press-glass"
            style={{ borderColor: 'var(--border-primary)', background: '#fff', color: '#1f1f1f' }}
        >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <GoogleLogo />}
            {t('oidc.loginButton') || 'Sign in with Google'}
        </button>
    );
};

export default GoogleSignInButton;
