import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './src/App';
import { ThemeProvider } from './src/contexts/ThemeContext';
import { AuthProvider } from './src/contexts/AuthContext';
import { SecurityPasswordProvider } from './src/contexts/SecurityPasswordContext';
import { CloudSyncProvider } from './src/contexts/CloudSyncContext';
import { registerSW } from 'virtual:pwa-register';

// An installed PWA can stay open for days without a navigation, so it would
// never notice a new deploy: check hourly (as AtDo's ReloadPrompt does).
// registerType 'autoUpdate' then activates the new version.
const SW_UPDATE_CHECK_MS = 60 * 60 * 1000;
registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
        if (!registration) return;
        setInterval(() => {
            if (navigator.onLine) registration.update().catch(() => {});
        }, SW_UPDATE_CHECK_MS);
    },
});

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <BrowserRouter>
                <ThemeProvider>
                    <AuthProvider>
                        <SecurityPasswordProvider>
                            <CloudSyncProvider>
                                <App />
                            </CloudSyncProvider>
                        </SecurityPasswordProvider>
                    </AuthProvider>
                </ThemeProvider>
            </BrowserRouter>
        </React.StrictMode>
    );
}
