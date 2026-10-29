import React from 'react';
import { ListChecks, Plus, Pencil, ArrowUp, ArrowDown } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useAppData } from '../contexts/AppDataContext';
import { getRouteIcon } from '../utils/helpers';
import { formatRegimenDose, regimenDisplayName } from '../utils/regimenDisplay';
import type { Regimen } from '../utils/regimens';

interface Props {
    onAdd: () => void;
    onEdit: (r: Regimen) => void;
}

/** Settings card listing the saved medication regimens (藥物方案). */
const RegimenManager: React.FC<Props> = ({ onAdd, onEdit }) => {
    const { t } = useTranslation();
    const { regimens, setRegimens, gelProducts } = useAppData();

    const move = (index: number, delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= regimens.length) return;
        const next = [...regimens];
        [next[index], next[target]] = [next[target], next[index]];
        setRegimens(next);
    };

    return (
        <div className="rounded-2xl glass-card p-4 space-y-3">
            <div className="flex items-start gap-3">
                <ListChecks size={20} style={{ color: 'var(--accent-500)' }} className="shrink-0" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('regimen.title')}</p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('regimen.desc')}</p>
                </div>
                <button onClick={onAdd}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white glass-btn-primary btn-press-glass">
                    <Plus size={14} /> {t('regimen.add')}
                </button>
            </div>

            {regimens.length === 0 ? (
                <p className="text-xs text-center py-4 rounded-xl border border-dashed"
                    style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}>
                    {t('regimen.empty')}
                </p>
            ) : (
                <ul className="divide-y rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-primary)' }}>
                    {regimens.map((r, i) => (
                        <li key={r.id} className="flex items-center gap-3 px-3 py-2.5" style={{ borderColor: 'var(--border-secondary)' }}>
                            <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border"
                                style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)' }}>
                                {getRouteIcon(r.route)}
                            </span>
                            <button className="min-w-0 flex-1 text-left" onClick={() => onEdit(r)}>
                                <span className="block text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>{regimenDisplayName(r, t, gelProducts)}</span>
                                <span className="block text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>{formatRegimenDose(r, t, gelProducts)}</span>
                            </button>
                            <div className="flex items-center gap-0.5 shrink-0">
                                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('regimen.move_up')}
                                    className="p-1.5 rounded-lg disabled:opacity-30" style={{ color: 'var(--text-tertiary)' }}>
                                    <ArrowUp size={14} />
                                </button>
                                <button onClick={() => move(i, 1)} disabled={i === regimens.length - 1} aria-label={t('regimen.move_down')}
                                    className="p-1.5 rounded-lg disabled:opacity-30" style={{ color: 'var(--text-tertiary)' }}>
                                    <ArrowDown size={14} />
                                </button>
                                <button onClick={() => onEdit(r)} aria-label={t('regimen.edit_title')}
                                    className="p-1.5 rounded-lg" style={{ color: 'var(--text-secondary)' }}>
                                    <Pencil size={14} />
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>{t('regimen.gel_hint')}</p>
        </div>
    );
};

export default RegimenManager;
