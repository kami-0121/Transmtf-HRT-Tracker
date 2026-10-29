import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { TRANSLATIONS, Lang } from '../i18n/translations';
import { CLOUD_BACKEND } from '../api/config';

// The sign-in provider behind the OIDC pages: the original Transmtf server, or
// Google on this fork's own D1 backend (server/google.ts).
const PROVIDER_KEY = /^(oidc|oidcGate|account\.oidc|login\.error\.oidcBound)/;
const withProvider = (key: string, text: string) =>
    CLOUD_BACKEND === 'd1' && PROVIDER_KEY.test(key) ? text.replace(/Transmtf/g, 'Google') : text;

const LanguageContext = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string } | null>(null);

export const useTranslation = () => {
    const ctx = useContext(LanguageContext);
    if (!ctx) throw new Error("useTranslation must be used within LanguageProvider");
    return ctx;
};

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
    const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('hrt-lang') as Lang) || 'zh');
    const isInitialLangRef = useRef(true);

    useEffect(() => {
        localStorage.setItem('hrt-lang', lang);
        document.title = lang === 'zh-TW' ? "HRT 紀錄" : lang === 'zh' ? "HRT 记录" : "Transmtf HRT Tracker";
        if (isInitialLangRef.current) {
            isInitialLangRef.current = false;
            return;
        }
        const lastModified = new Date().toISOString();
        localStorage.setItem('hrt-last-modified', lastModified);
        localStorage.setItem('hrt-last-data-updated', lastModified);
        window.dispatchEvent(new CustomEvent('hrt-local-data-updated', { detail: { key: 'hrt-lang', lastModified } }));
    }, [lang]);

    const t = (key: string) => {
        const pack = (TRANSLATIONS as any)[lang] || TRANSLATIONS.zh;
        return withProvider(key, pack[key] ?? TRANSLATIONS.zh[key as keyof typeof TRANSLATIONS.zh] ?? TRANSLATIONS.en[key as keyof typeof TRANSLATIONS.en] ?? key);
    };

    return (
        <LanguageContext.Provider value={{ lang, setLang, t }}>
            {children}
        </LanguageContext.Provider>
    );
};
