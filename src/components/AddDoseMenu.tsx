import React, { useEffect, useRef, useState } from 'react';
import { Plus, PenLine, ListChecks, Settings2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../contexts/LanguageContext';
import { useAppData } from '../contexts/AppDataContext';
import { getRouteIcon } from '../utils/helpers';
import { formatRegimenDose, regimenDisplayName } from '../utils/regimenDisplay';
import type { Regimen } from '../utils/regimens';

interface Props {
    /** Open the full dose form (the original, free-form way of logging). */
    onAddCustom: () => void;
    /** Log a regimen now. */
    onAddRegimen: (regimen: Regimen) => void;
    /** Visual size of the trigger button. */
    variant?: 'header' | 'compact';
    className?: string;
}

/**
 * "+" button that offers the saved medication regimens for one-tap logging,
 * plus the original free-form dose form for doses that differ from usual.
 * With no regimens saved it behaves like the plain add button.
 */
const AddDoseMenu: React.FC<Props> = ({ onAddCustom, onAddRegimen, variant = 'header', className = '' }) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { regimens, gelProducts } = useAppData();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent | TouchEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('touchstart', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('touchstart', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const handleTrigger = () => {
        if (regimens.length === 0) { onAddCustom(); return; }
        setOpen(o => !o);
    };

    const triggerClass = variant === 'header'
        ? 'flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-bold text-white whitespace-nowrap glass-btn-primary btn-press-glass transition'
        : 'shrink-0 inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-3 min-[360px]:px-3.5 text-xs font-bold text-white glass-btn-primary btn-press-glass transition';

    return (
        <div ref={rootRef} className={`relative ${className}`}>
            <button
                onClick={handleTrigger}
                aria-haspopup={regimens.length > 0 ? 'menu' : undefined}
                aria-expanded={regimens.length > 0 ? open : undefined}
                aria-label={t('btn.add')}
                className={triggerClass}
            >
                <Plus size={15} />
                <span className={variant === 'compact' ? 'hidden min-[360px]:inline' : ''}>{t('btn.add')}</span>
            </button>
            {open && (
                <div role="menu"
                    className="absolute right-0 top-full mt-2 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-2xl glass-modal border overflow-hidden"
                    style={{ borderColor: 'var(--border-primary)', boxShadow: 'var(--shadow-md)', background: 'var(--bg-card)' }}>
                    <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--text-tertiary)' }}>
                        <ListChecks size={12} /> {t('regimen.quick_title')}
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                        {regimens.map(r => (
                            <button key={r.id} role="menuitem"
                                onClick={() => { setOpen(false); onAddRegimen(r); }}
                                className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition hover:bg-[var(--bg-card-hover)]">
                                <span className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border"
                                    style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)' }}>
                                    {getRouteIcon(r.route)}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>{regimenDisplayName(r, t, gelProducts)}</span>
                                    <span className="block text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>{formatRegimenDose(r, t, gelProducts)}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                    <div className="border-t" style={{ borderColor: 'var(--border-secondary)' }}>
                        <button role="menuitem" onClick={() => { setOpen(false); onAddCustom(); }}
                            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition hover:bg-[var(--bg-card-hover)]"
                            style={{ color: 'var(--accent-500)' }}>
                            <PenLine size={15} /> {t('regimen.add_custom')}
                        </button>
                        <button role="menuitem" onClick={() => { setOpen(false); navigate('/settings#regimens'); }}
                            className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-semibold transition hover:bg-[var(--bg-card-hover)]"
                            style={{ color: 'var(--text-tertiary)' }}>
                            <Settings2 size={14} /> {t('regimen.manage')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AddDoseMenu;
