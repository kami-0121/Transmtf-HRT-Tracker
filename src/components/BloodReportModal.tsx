import React, { useEffect, useMemo, useState } from 'react';
import { X, Calendar, Trash2, Check, Droplet, ChevronDown, ChevronUp, FileText } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../contexts/LanguageContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
    ANALYTES, ANALYTE_CATEGORY_ORDER, E2_ANALYTE_ID, formatRefRange, rangeFlag, toCanonical,
    type AnalyteCategory, type BloodRow, type BloodValue,
} from '../utils/bloodTests';

export interface BloodReportDraft {
    id: string;
    timeH: number;
    values: Record<string, BloodValue>; // may include 'e2'
    note?: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onSave: (draft: BloodReportDraft) => void;
    onDelete?: (id: string) => void;
    rowToEdit?: BloodRow | null;
}

type Entry = { value: string; unit: string };

const pad = (n: number) => n.toString().padStart(2, '0');
const toLocalDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const DEFAULT_OPEN: AnalyteCategory[] = ['hormone'];

const BloodReportModal: React.FC<Props> = ({ isOpen, onClose, onSave, onDelete, rowToEdit }) => {
    const { t } = useTranslation();
    const [date, setDate] = useState('');
    const [time, setTime] = useState('');
    const [note, setNote] = useState('');
    const [entries, setEntries] = useState<Record<string, Entry>>({});
    const [open, setOpen] = useState<Set<AnalyteCategory>>(new Set(DEFAULT_OPEN));

    useEffect(() => {
        if (!isOpen) return;
        const d = rowToEdit ? new Date(rowToEdit.timeH * 3600000) : new Date();
        setDate(toLocalDate(d));
        setTime(toLocalTime(d));
        setNote(rowToEdit?.note ?? '');
        const next: Record<string, Entry> = {};
        for (const a of ANALYTES) {
            const v = rowToEdit?.values[a.id];
            next[a.id] = v ? { value: String(v.value), unit: v.unit } : { value: '', unit: a.units[0].unit };
        }
        setEntries(next);
        // Open every category that already holds a value (plus hormones).
        const cats = new Set<AnalyteCategory>(DEFAULT_OPEN);
        if (rowToEdit) for (const a of ANALYTES) if (rowToEdit.values[a.id]) cats.add(a.category);
        setOpen(cats);
    }, [isOpen, rowToEdit]);

    const parsedValues = useMemo(() => {
        const out: Record<string, BloodValue> = {};
        for (const a of ANALYTES) {
            const e = entries[a.id];
            if (!e || e.value.trim() === '') continue;
            const n = parseFloat(e.value);
            if (Number.isFinite(n) && n >= 0) out[a.id] = { value: n, unit: e.unit };
        }
        return out;
    }, [entries]);

    const filledCount = Object.keys(parsedValues).length;
    const canSave = !!date && !!time && filledCount > 0;

    const dialogRef = useFocusTrap(isOpen, onClose);
    if (!isOpen) return null;

    const handleSave = () => {
        if (!canSave) return;
        const timeH = new Date(`${date}T${time}`).getTime() / 3600000;
        if (!Number.isFinite(timeH)) return;
        onSave({ id: rowToEdit?.id ?? uuidv4(), timeH, values: parsedValues, note: note.trim() || undefined });
        onClose();
    };

    const toggle = (c: AnalyteCategory) => setOpen(prev => {
        const next = new Set(prev);
        if (next.has(c)) next.delete(c); else next.add(c);
        return next;
    });

    const inputStyle = { background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' };

    return (
        <div className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="blood-modal-title"
                className="rounded-3xl w-full max-w-lg md:max-w-2xl overflow-hidden flex flex-col h-[90vh] md:max-h-[85vh] modal-spring-glass glass-modal"
            >
                <div className="px-6 py-4 border-b flex items-center justify-between shrink-0"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    <h2 id="blood-modal-title" className="text-lg font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        <Droplet className="text-rose-500" size={20} />
                        {rowToEdit ? t('blood.edit_title') : t('blood.add_title')}
                    </h2>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition-colors"
                        style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
                        <X size={20} />
                    </button>
                </div>

                <div className="p-4 sm:p-6 overflow-y-auto space-y-4 flex-1">
                    <div className="space-y-2">
                        <label className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                            <Calendar size={16} style={{ color: 'var(--text-tertiary)' }} />
                            {t('blood.draw_time')}
                        </label>
                        <div className="flex gap-3">
                            <input type="date" value={date} onChange={e => setDate(e.target.value)}
                                className="flex-1 min-w-0 text-sm rounded-xl p-3 font-medium" style={inputStyle} />
                            <input type="time" value={time} onChange={e => setTime(e.target.value)}
                                className="w-32 text-sm rounded-xl p-3 font-medium text-center" style={inputStyle} />
                        </div>
                    </div>

                    <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>{t('blood.form_hint')}</p>

                    {ANALYTE_CATEGORY_ORDER.map(cat => {
                        const items = ANALYTES.filter(a => a.category === cat);
                        const filled = items.filter(a => parsedValues[a.id]).length;
                        const isOpenCat = open.has(cat);
                        return (
                            <div key={cat} className="rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border-primary)' }}>
                                <button type="button" onClick={() => toggle(cat)} aria-expanded={isOpenCat}
                                    className="w-full flex items-center justify-between px-4 py-3"
                                    style={{ background: 'var(--bg-card-hover)', color: 'var(--text-primary)' }}>
                                    <span className="text-sm font-bold">{t(`blood.category.${cat}`)}</span>
                                    <span className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                        {filled > 0 && <span className="px-2 py-0.5 rounded-full font-bold" style={{ background: 'var(--accent-50)', color: 'var(--accent-500)' }}>{filled}</span>}
                                        {isOpenCat ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                    </span>
                                </button>
                                {isOpenCat && (
                                    <div className="divide-y" style={{ borderColor: 'var(--border-secondary)' }}>
                                        {items.map(a => {
                                            const e = entries[a.id] ?? { value: '', unit: a.units[0].unit };
                                            const pv = parsedValues[a.id];
                                            const flag = pv ? rangeFlag(a.id, toCanonical(a.id, pv)) : null;
                                            const ref = formatRefRange(a);
                                            return (
                                                <div key={a.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                                                    <div className="flex-1 min-w-[9rem]">
                                                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                                            {t(`blood.analyte.${a.id}`)} <span className="text-xs font-mono" style={{ color: 'var(--text-tertiary)' }}>{a.short}</span>
                                                        </div>
                                                        {ref && (
                                                            <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                                                                {a.id === E2_ANALYTE_ID ? t('blood.ref_gaht') : t('blood.ref')} {ref}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-1.5">
                                                        <input
                                                            type="number" inputMode="decimal" min={0} step="any"
                                                            aria-label={t(`blood.analyte.${a.id}`)}
                                                            value={e.value}
                                                            onChange={ev => setEntries(prev => ({ ...prev, [a.id]: { ...e, value: ev.target.value } }))}
                                                            className="w-24 rounded-lg px-2 py-1.5 text-sm font-bold text-right"
                                                            style={{
                                                                ...inputStyle,
                                                                borderColor: flag === 'high' || flag === 'low' ? '#f59e0b' : 'var(--border-primary)',
                                                            }}
                                                        />
                                                        {a.units.length > 1 ? (
                                                            <select
                                                                value={e.unit}
                                                                aria-label={`${t(`blood.analyte.${a.id}`)} ${t('blood.unit')}`}
                                                                onChange={ev => setEntries(prev => ({ ...prev, [a.id]: { ...e, unit: ev.target.value } }))}
                                                                className="w-28 rounded-lg px-1.5 py-1.5 text-xs"
                                                                style={inputStyle}
                                                            >
                                                                {a.units.map(u => <option key={u.unit} value={u.unit}>{u.unit}</option>)}
                                                            </select>
                                                        ) : (
                                                            <span className="w-28 text-xs px-1.5" style={{ color: 'var(--text-tertiary)' }}>{a.units[0].unit}</span>
                                                        )}
                                                    </div>
                                                    {flag === 'high' || flag === 'low' ? (
                                                        <span className="w-full text-[10px] font-bold text-amber-600 dark:text-amber-400">
                                                            {t(flag === 'high' ? 'blood.flag_high' : 'blood.flag_low')}
                                                        </span>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    <div className="space-y-2">
                        <label className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                            <FileText size={16} style={{ color: 'var(--text-tertiary)' }} />
                            {t('blood.note')}
                        </label>
                        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={500}
                            placeholder={t('blood.note_placeholder')}
                            className="w-full text-sm rounded-xl p-3" style={inputStyle} />
                    </div>
                </div>

                <div className="p-4 border-t flex gap-3 shrink-0 safe-area-pb"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    {rowToEdit && onDelete && (
                        <button onClick={() => { onDelete(rowToEdit.id); onClose(); }} aria-label={t('btn.delete')}
                            className="p-4 text-red-500 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-xl transition-colors">
                            <Trash2 size={20} />
                        </button>
                    )}
                    <button onClick={handleSave} disabled={!canSave}
                        className="flex-1 text-white font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 glass-btn-primary btn-press-glass">
                        <Check size={20} />
                        {t('btn.save')}{filledCount > 0 ? `（${filledCount}）` : ''}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default BloodReportModal;
