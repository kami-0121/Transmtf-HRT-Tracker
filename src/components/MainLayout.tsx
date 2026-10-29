import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { Settings, Activity, Calendar, User } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useAuth } from '../contexts/AuthContext';
import { API_ORIGIN } from '../api/config';
import { useAppData, PER_DOSE_WEIGHT_MIGRATION_EVENT } from '../contexts/AppDataContext';
import { formatDate, formatTime } from '../utils/helpers';
import { clearAllLocalMedicalData } from '../utils/localDataCleanup';
import { DoseEvent } from '../../logic';
import { E2_ANALYTE_ID, bloodValueToLabResult, type BloodRow } from '../utils/bloodTests';
import { regimenToEvent, eventToRegimen, type Regimen } from '../utils/regimens';
import { regimenDisplayName, formatRegimenDose } from '../utils/regimenDisplay';
import { prefillWeightKG } from '../utils/weight';

import DoseFormModal from './DoseFormModal';
import BatchDoseModal from './BatchDoseModal';
import BloodReportModal, { type BloodReportDraft } from './BloodReportModal';
import AddDoseMenu from './AddDoseMenu';

type ViewKey = 'home' | 'history' | 'settings';

const MainLayout: React.FC = () => {
    const { t, lang } = useTranslation();
    const { showDialog } = useDialog();
    const navigate = useNavigate();
    const location = useLocation();
    const { isAuthenticated, user } = useAuth();
    const { events, setEvents, setLabResults, setBloodReports, regimens, setRegimens, gelProducts, currentTime, isComputing } = useAppData();

    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingEvent, setEditingEvent] = useState<DoseEvent | null>(null);
    const [isBloodModalOpen, setIsBloodModalOpen] = useState(false);
    const [editingBloodRow, setEditingBloodRow] = useState<BloodRow | null>(null);
    const [isRegimenFormOpen, setIsRegimenFormOpen] = useState(false);
    const [editingRegimen, setEditingRegimen] = useState<Regimen | null>(null);
    const [isBatchOpen, setIsBatchOpen] = useState(false);

    const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
    const [avatarError, setAvatarError] = useState(false);
    const mainScrollRef = useRef<HTMLDivElement>(null);

    const currentView = useMemo<ViewKey | null>(() => {
        const { pathname } = location;
        if (pathname === '/') return 'home';
        if (pathname.startsWith('/history')) return 'history';
        // Settings now also hosts the account ("我的") and calibration pages.
        if (pathname.startsWith('/settings') || pathname.startsWith('/lab')) return 'settings';
        if (pathname === '/profile' || pathname === '/account' || pathname.startsWith('/account/')) return 'settings';
        return null;
    }, [location.pathname]);

    const handleViewChange = (view: ViewKey) => {
        const routes: Record<ViewKey, string> = {
            home: '/',
            history: '/history',
            settings: '/settings',
        };
        navigate(routes[view]);
    };

    useEffect(() => {
        const handler = () => {
            showDialog('alert', t('migration.per_dose_weight'));
        };        window.addEventListener(PER_DOSE_WEIGHT_MIGRATION_EVENT, handler);
        return () => window.removeEventListener(PER_DOSE_WEIGHT_MIGRATION_EVENT, handler);
    }, [showDialog, t]);

    useEffect(() => {
        const shouldLock = isFormOpen || isBloodModalOpen || isBatchOpen || isRegimenFormOpen;
        document.body.style.overflow = shouldLock ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
    }, [isFormOpen, isBloodModalOpen, isBatchOpen, isRegimenFormOpen]);

    useEffect(() => {
        const el = mainScrollRef.current;
        if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
        const notifyLayout = () => window.dispatchEvent(new Event('resize'));
        const rafIds: number[] = [];
        const raf1 = requestAnimationFrame(() => {
            notifyLayout();
            rafIds.push(requestAnimationFrame(notifyLayout));
        });
        rafIds.push(raf1);
        const timers = [100, 300, 600].map(delay => setTimeout(notifyLayout, delay));
        return () => {
            rafIds.forEach(cancelAnimationFrame);
            timers.forEach(clearTimeout);
        };
    }, [location.pathname]);

    useEffect(() => {
        if (isAuthenticated && user) {
            // Prefer OIDC avatar URL, fallback to uploaded avatar
            if (user.avatarUrl) {
                setAvatarUrl(user.avatarUrl);
            } else if (user.username) {
                setAvatarUrl(`${API_ORIGIN}/api/avatars/${user.username}`);
            }
            setAvatarError(false);
        } else {
            setAvatarUrl(null);
            setAvatarError(false);
        }
    }, [isAuthenticated, user]);

    // FINAL-REVIEW (blocker 1): this device holds medical records that were
    // never synced under the current account. Sync is paused (see canSync)
    // until the user decides what should happen to them — otherwise the new
    // account's first sync would upload the previous account's records.
    const ownershipPromptShownRef = useRef(false);
    useEffect(() => {
        if (!isAuthenticated || ownershipPromptShownRef.current) return;
        if (localStorage.getItem('hrt-data-ownership-pending') !== '1') return;
        ownershipPromptShownRef.current = true;
        (async () => {
            const choice = await showDialog('confirm', t('sync.ownership_prompt'), {
                confirmText: t('sync.ownership_upload'),
                cancelText: t('sync.ownership_clear'),
                thirdOption: t('sync.ownership_later'),
            });
            if (choice === 'confirm') {
                // Upload: sync resumes and pushes the local records to this account.
                localStorage.removeItem('hrt-data-ownership-pending');
            } else if (choice === 'cancel') {
                // Clear: wipe local records (storage + in-memory state holders).
                clearAllLocalMedicalData();
                localStorage.removeItem('hrt-data-ownership-pending');
            }
            // 'third' (later): keep the flag — sync stays paused; the prompt
            // reappears on the next mount.
            ownershipPromptShownRef.current = false;
        })();
    }, [isAuthenticated, showDialog, t]);

    const navItems = useMemo(() => [
        { id: 'home' as ViewKey, label: t('nav.home'), icon: Activity },
        { id: 'history' as ViewKey, label: t('nav.history'), icon: Calendar },
        { id: 'settings' as ViewKey, label: t('nav.settings'), icon: Settings },
    ], [t]);

    const handleAddEvent = () => { setEditingEvent(null); setIsFormOpen(true); };
    const handleEditEvent = (e: DoseEvent) => { setEditingEvent(e); setIsFormOpen(true); };
    const handleAddBloodReport = () => { setEditingBloodRow(null); setIsBloodModalOpen(true); };
    const handleEditBloodRow = (row: BloodRow) => { setEditingBloodRow(row); setIsBloodModalOpen(true); };
    // A report's E2 value is written to labResults under the report id (the
    // calibration source); every other analyte goes to bloodReports.
    const handleSaveBloodReport = (draft: BloodReportDraft) => {
        const { [E2_ANALYTE_ID]: e2, ...rest } = draft.values;
        const hasReport = Object.keys(rest).length > 0 || !!draft.note;
        setBloodReports(prev => {
            const others = prev.filter(r => r.id !== draft.id);
            return hasReport ? [...others, { id: draft.id, timeH: draft.timeH, values: rest, ...(draft.note ? { note: draft.note } : {}) }] : others;
        });
        setLabResults(prev => {
            const others = prev.filter(r => r.id !== draft.id);
            return e2 ? [...others, bloodValueToLabResult(draft.id, draft.timeH, e2)] : others;
        });
    };
    const handleDeleteBloodRow = (id: string) => {
        showDialog('confirm', t('blood.delete_confirm'), () => {
            setBloodReports(prev => prev.filter(r => r.id !== id));
            setLabResults(prev => prev.filter(r => r.id !== id));
        });
    };

    // ── Medication regimens ──
    const handleAddRegimenDose = async (r: Regimen) => {
        const label = `${regimenDisplayName(r, t, gelProducts)}\n${formatRegimenDose(r, t, gelProducts)}`;
        const choice = await showDialog('confirm', t('regimen.log_confirm').replace('{regimen}', label));
        if (choice !== 'confirm') return;
        const nowH = Date.now() / 3600000;
        setEvents(prev => [...prev, regimenToEvent(r, nowH, prefillWeightKG(prev))]);
    };
    const openRegimenForm = (r: Regimen | null) => { setEditingRegimen(r); setIsRegimenFormOpen(true); };
    const handleSaveRegimen = (e: DoseEvent, name: string) => {
        const regimen = eventToRegimen(e, editingRegimen?.id ?? e.id, name);
        setRegimens(prev => {
            const exists = prev.some(p => p.id === regimen.id);
            return exists ? prev.map(p => (p.id === regimen.id ? regimen : p)) : [...prev, regimen];
        });
    };
    const handleDeleteRegimen = (id: string) => {
        showDialog('confirm', t('regimen.delete_confirm'), () => {
            setRegimens(prev => prev.filter(r => r.id !== id));
        });
    };
    const handleSaveEvent = (e: DoseEvent) => {
        setEvents(prev => {
            const exists = prev.find(p => p.id === e.id);
            return exists ? prev.map(p => p.id === e.id ? e : p) : [...prev, e];
        });
    };
    const handleDeleteEvent = (id: string) => {
        showDialog('confirm', t('timeline.delete_confirm'), () => {
            setEvents(prev => prev.filter(e => e.id !== id));
        });
    };
    const handleSaveBatch = (newEvents: DoseEvent[]) => {
        setEvents(prev => [...prev, ...newEvents]);
    };

    return (
        <div className="h-screen w-full overflow-x-hidden flex flex-col select-none font-sans"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', overscrollBehaviorX: 'none' }}>

            {/* ── Desktop top bar ──
                Three width tiers so the bar never overflows (the layout clips
                horizontally, so an overflowing bar silently loses the add
                button and avatar):
                  md  (tablet portrait): logo only, compact nav, no clock
                  lg  (tablet landscape / small laptop): full-size nav, side
                      blocks get equal minimum widths so the nav sits centred
                  xl  (desktop): + brand name and clock
                English is the widest locale and sets these thresholds. */}
            <header className="hidden md:flex shrink-0 items-center justify-between gap-3 px-4 lg:px-6 h-16 sticky top-0 z-20 glass"
                style={{
                    boxShadow: 'var(--shadow-sm)',
                }}
            >
                <div className="flex shrink-0 items-center gap-3 lg:min-w-[160px] xl:min-w-[220px]">
                    <div className="h-9 w-9 rounded-xl border overflow-hidden"
                        style={{ borderColor: 'var(--border-primary)' }}>
                        <img src="/favicon.ico" alt="logo" className="h-full w-full object-cover" />
                    </div>
                    <p className="hidden xl:block text-sm font-black tracking-tight whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>Transmtf HRT Tracker</p>
                </div>

                <nav aria-label={t('nav.aria_primary')} className="flex shrink-0 items-center gap-1">
                    {navItems.map(({ id, label, icon: Icon }) => {
                        const active = currentView === id;
                        return (
                            <button
                                key={id}
                                onClick={() => handleViewChange(id)}
                                aria-current={active ? 'page' : undefined}
                                className={`flex items-center gap-1.5 lg:gap-2 px-2 lg:px-3 py-2 rounded-xl text-xs lg:text-sm font-semibold whitespace-nowrap btn-press-glass transition-all duration-200 ${
                                    active
                                        ? 'glass-btn-primary text-white'
                                        : 'glass-btn hover:bg-[var(--glass-bg-default)]'
                                }`}
                                style={active ? {} : {
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                <Icon size={15} className="shrink-0" />
                                <span>{label}</span>
                            </button>
                        );
                    })}
                </nav>

                <div className="flex shrink-0 items-center gap-2 lg:gap-3 lg:min-w-[160px] xl:min-w-[260px] justify-end">
                    {/* F07: explicit PK computation status — a long history recomputes
                        in a worker; without any indicator old values look final.
                        The pill takes the clock's slot while computing so the
                        bar keeps its width; below xl (no clock) it collapses to
                        the bare pulsing dot. */}
                    {isComputing ? (
                        <span className="flex items-center gap-1.5 rounded-full xl:border xl:border-[var(--accent-200)] xl:bg-[var(--accent-50)] xl:px-3 xl:py-1.5 text-xs font-semibold whitespace-nowrap"
                            style={{ color: 'var(--accent-500)' }}
                            title={t('common.computing') || '计算中…'}>
                            <span className="inline-block h-2 w-2 rounded-full animate-pulse" style={{ background: 'var(--accent-500)' }} aria-hidden="true" />
                            <span className="hidden xl:inline">{t('common.computing') || '计算中…'}</span>
                            <span className="sr-only xl:hidden">{t('common.computing') || '计算中…'}</span>
                        </span>
                    ) : (
                        <div className="hidden xl:flex items-center gap-2 rounded-full glass-subtle px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
                            style={{
                                color: 'var(--text-secondary)',
                            }}>
                            <span>{formatDate(currentTime, lang)}</span>
                            <span style={{ color: 'var(--accent-300)' }}>·</span>
                            <span className="font-mono">{formatTime(currentTime)}</span>
                        </div>
                    )}
                    <AddDoseMenu onAddCustom={handleAddEvent} onAddRegimen={handleAddRegimenDose} />
                    <button
                        onClick={() => navigate('/settings')}
                        aria-label={t('nav.account') || 'Profile'}
                        className="h-9 w-9 rounded-full border-2 overflow-hidden transition"
                        style={{ borderColor: 'var(--border-primary)' }}
                        onMouseEnter={(e) => e.currentTarget.style.borderColor = `var(--accent-400)`}
                        onMouseLeave={(e) => e.currentTarget.style.borderColor = `var(--border-primary)`}
                    >
                        {isAuthenticated && avatarUrl && !avatarError ? (
                            <img src={avatarUrl} alt="" aria-hidden="true" className="h-full w-full object-cover" onError={() => setAvatarError(true)} />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center"
                                style={{ background: 'var(--bg-card-hover)' }}>
                                <User size={17} style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                            </div>
                        )}
                    </button>
                </div>
            </header>

            {/* ── Scrollable content ── */}
            <main
                ref={mainScrollRef}
                className="flex-1 overflow-y-auto overflow-x-hidden"
                style={{ background: 'var(--bg-secondary)', overscrollBehaviorX: 'none', touchAction: 'pan-y' }}
            >
                <div
                    key={location.pathname}
                    className="min-h-full max-w-full overflow-x-hidden"
                    style={{ animation: 'fadeSlideIn 0.25s ease-out' }}
                >
                    <Outlet context={{
                        onEditEvent: handleEditEvent,
                        onAddEvent: handleAddEvent,
                        onBatchAdd: () => setIsBatchOpen(true),
                        onAddRegimenDose: handleAddRegimenDose,
                        onAddBloodReport: handleAddBloodReport,
                        onEditBloodRow: handleEditBloodRow,
                        onAddRegimen: () => openRegimenForm(null),
                        onEditRegimen: (r: Regimen) => openRegimenForm(r),
                    }} />
                    {/* bottom padding so content isn't hidden behind the mobile nav */}
                    <div className="h-24 md:h-4" />
                </div>
            </main>

            {/* ── Mobile bottom nav — Glass Pill ── */}
            <nav aria-label={t('nav.aria_mobile')} className="fixed bottom-0 left-0 right-0 z-40 md:hidden px-3 pt-1 pb-3"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)', background: 'linear-gradient(to top, var(--bg-secondary) 75%, transparent)' }}>
                <div
                    className="rounded-3xl px-1.5 py-1.5 glass"
                    style={{
                        boxShadow: 'var(--shadow-md)',
                    }}
                >
                    <div className="grid grid-cols-3">
                        {navItems.map(({ id, label, icon: Icon }) => {
                            const active = currentView === id;
                            return (
                                <button
                                    key={id}
                                    onClick={() => handleViewChange(id)}
                                    aria-current={active ? 'page' : undefined}
                                    className={`relative flex flex-col items-center gap-0.5 py-2.5 px-1 rounded-2xl transition-all duration-200 btn-press-glass ${
                                        active ? 'glass-btn' : ''
                                    }`}
                                >
                                    <Icon
                                        size={22}
                                        style={{
                                            color: active ? 'var(--accent-500)' : 'var(--text-tertiary)',
                                            transition: 'color 0.2s',
                                        }}
                                    />
                                    <span
                                        className="text-[10px] font-semibold leading-none"
                                        style={{
                                            color: active ? 'var(--accent-500)' : 'var(--text-tertiary)',
                                            transition: 'color 0.2s',
                                        }}
                                    >
                                        {label}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </nav>

            <style>{`
                @keyframes fadeSlideIn {
                    from { opacity: 0; transform: translateY(6px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
            `}</style>

            {/* ── Modals ── */}
            <DoseFormModal
                isOpen={isFormOpen}
                onClose={() => setIsFormOpen(false)}
                eventToEdit={editingEvent}
                onSave={handleSaveEvent}
                onDelete={handleDeleteEvent}
            />
            <BloodReportModal
                isOpen={isBloodModalOpen}
                onClose={() => setIsBloodModalOpen(false)}
                onSave={handleSaveBloodReport}
                onDelete={handleDeleteBloodRow}
                rowToEdit={editingBloodRow}
            />
            <DoseFormModal
                isOpen={isRegimenFormOpen}
                onClose={() => setIsRegimenFormOpen(false)}
                regimenMode
                regimenToEdit={editingRegimen}
                onSave={() => { /* regimen mode saves through onSaveRegimen */ }}
                onSaveRegimen={handleSaveRegimen}
                onDelete={handleDeleteRegimen}
            />
            <BatchDoseModal
                isOpen={isBatchOpen}
                onClose={() => setIsBatchOpen(false)}
                onSaveBatch={handleSaveBatch}
            />
        </div>
    );
};

export default MainLayout;
