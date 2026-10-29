import React, { useEffect, useMemo, useState } from 'react';
import { Droplet, Plus, TrendingUp } from 'lucide-react';
import {
    ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ReferenceLine,
} from 'recharts';
import { useTranslation } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import { formatDate, formatTime } from '../utils/helpers';
import {
    ANALYTES, ANALYTE_CATEGORY_ORDER, analyteSeries, getAnalyte, rangeFlag, toCanonical,
    type BloodRow,
} from '../utils/bloodTests';

interface BloodViewProps {
    rows: BloodRow[];
    onAdd: () => void;
    onEdit: (row: BloodRow) => void;
}

const fmtNum = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

const BloodView: React.FC<BloodViewProps> = ({ rows, onAdd, onEdit }) => {
    const { t, lang } = useTranslation();
    const { isDark } = useTheme();

    // Analytes that actually have data, in catalog order.
    const available = useMemo(
        () => ANALYTES.filter(a => rows.some(r => r.values[a.id])),
        [rows]
    );
    const [selected, setSelected] = useState<string | null>(null);
    useEffect(() => {
        if (!selected || !available.some(a => a.id === selected)) {
            setSelected(available[0]?.id ?? null);
        }
    }, [available, selected]);

    const spec = selected ? getAnalyte(selected) : undefined;
    const series = useMemo(
        () => (selected ? analyteSeries(rows, selected).map(p => ({ time: p.timeH * 3600000, value: p.value })) : []),
        [rows, selected]
    );

    const yDomain = useMemo<[number, number]>(() => {
        if (!spec || series.length === 0) return [0, 1];
        const vals = series.map(p => p.value);
        if (spec.refLow !== undefined) vals.push(spec.refLow);
        if (spec.refHigh !== undefined) vals.push(spec.refHigh);
        const max = Math.max(...vals);
        const min = Math.min(...vals);
        const pad = (max - min) * 0.15 || max * 0.2 || 1;
        return [Math.max(0, min - pad), max + pad];
    }, [spec, series]);

    const grouped = useMemo(() => {
        const groups: { date: string; items: BloodRow[] }[] = [];
        for (const r of rows) {
            const d = formatDate(new Date(r.timeH * 3600000), lang);
            const last = groups[groups.length - 1];
            if (last && last.date === d) last.items.push(r);
            else groups.push({ date: d, items: [r] });
        }
        return groups;
    }, [rows, lang]);

    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    const axisColor = isDark ? '#9ca3af' : '#6b7280';

    return (
        <div className="space-y-5">
            {/* Header */}
            <div className="px-4">
                <div className="w-full p-4 rounded-2xl glass-card glass-highlight relative overflow-hidden flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold tracking-tight flex items-center gap-3 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                        <Droplet size={22} className="shrink-0 text-rose-400" /> {t('blood.title')}
                    </h2>
                    <button onClick={onAdd}
                        className="ml-auto inline-flex items-center justify-center gap-2 px-3.5 py-2 h-11 rounded-xl text-white text-sm font-bold whitespace-nowrap btn-press-glass transition glass-btn-primary">
                        <Plus size={16} />
                        <span>{t('blood.add')}</span>
                    </button>
                </div>
            </div>

            {/* Trend chart */}
            {available.length > 0 && spec && (
                <div className="mx-4 glass-card rounded-2xl p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                        <TrendingUp size={16} style={{ color: 'var(--accent-400)' }} />
                        {t('blood.trend')}
                    </div>
                    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t('blood.trend')}>
                        {available.map(a => {
                            const active = a.id === selected;
                            return (
                                <button key={a.id} role="tab" aria-selected={active} onClick={() => setSelected(a.id)}
                                    className="px-2.5 py-1 rounded-full text-xs font-bold border transition"
                                    style={active
                                        ? { background: a.color, borderColor: a.color, color: '#fff' }
                                        : { background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                                    {a.short}
                                </button>
                            );
                        })}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t(`blood.analyte.${spec.id}`)}（{spec.units[0].unit}）
                    </div>
                    <div className="h-56 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" />
                                <XAxis
                                    dataKey="time" type="number" scale="time"
                                    domain={series.length > 1 ? ['dataMin', 'dataMax'] : ['dataMin - 86400000', 'dataMax + 86400000']}
                                    tickFormatter={(ms) => formatDate(new Date(ms), lang)}
                                    tick={{ fontSize: 10, fill: axisColor }} minTickGap={24}
                                />
                                <YAxis domain={yDomain} tick={{ fontSize: 10, fill: axisColor }} tickFormatter={fmtNum} width={48} />
                                {spec.refLow !== undefined && spec.refHigh !== undefined && (
                                    <ReferenceArea y1={spec.refLow} y2={spec.refHigh} fill="#10b981" fillOpacity={0.08} />
                                )}
                                {spec.refLow !== undefined && <ReferenceLine y={spec.refLow} stroke="#10b981" strokeDasharray="4 3" />}
                                {spec.refHigh !== undefined && <ReferenceLine y={spec.refHigh} stroke="#10b981" strokeDasharray="4 3" />}
                                <Tooltip
                                    labelFormatter={(ms) => `${formatDate(new Date(ms as number), lang)} ${formatTime(new Date(ms as number))}`}
                                    formatter={(v: number) => [`${fmtNum(v)} ${spec.units[0].unit}`, spec.short]}
                                    contentStyle={{ borderRadius: 12, fontSize: 12, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                />
                                <Line type="monotone" dataKey="value" stroke={spec.color} strokeWidth={2.5}
                                    dot={{ r: 4, fill: spec.color, stroke: '#fff', strokeWidth: 1.5 }} activeDot={{ r: 6 }} isAnimationActive={false} />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                    <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>{t('blood.ref_disclaimer')}</p>
                </div>
            )}

            {rows.length === 0 && (
                <div className="mx-4 text-center py-12 rounded-3xl border border-dashed"
                    style={{ color: 'var(--text-tertiary)', background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
                    <p>{t('blood.empty')}</p>
                </div>
            )}

            {grouped.map(({ date, items }) => (
                <div key={date} className="relative mx-4 rounded-2xl glass-card overflow-hidden">
                    <div className="py-3 px-4 flex items-center gap-2 border-b glass" style={{ borderColor: 'var(--border-secondary)' }}>
                        <div className="w-2 h-2 rounded-full bg-rose-300" />
                        <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{date}</span>
                    </div>
                    <div className="divide-y" style={{ borderColor: 'var(--border-secondary)' }}>
                        {items.map(row => {
                            const keys = ANALYTE_CATEGORY_ORDER.flatMap(c => ANALYTES.filter(a => a.category === c && row.values[a.id]));
                            return (
                                <button key={row.id} type="button" onClick={() => onEdit(row)}
                                    className="w-full text-left p-4 space-y-2 transition btn-press-glass hover:bg-[var(--bg-card-hover)]">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                                            {t('blood.report')} · {keys.length} {t('blood.items')}
                                        </span>
                                        <span className="font-mono text-[11px] font-medium px-2 py-1 rounded-md border"
                                            style={{ color: 'var(--text-secondary)', background: 'var(--bg-card-hover)', borderColor: 'var(--border-secondary)' }}>
                                            {formatTime(new Date(row.timeH * 3600000))}
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {keys.map(a => {
                                            const v = row.values[a.id];
                                            const flag = rangeFlag(a.id, toCanonical(a.id, v));
                                            const warn = flag === 'high' || flag === 'low';
                                            return (
                                                <span key={a.id} className="inline-flex items-baseline gap-1 px-2 py-1 rounded-lg border text-[11px]"
                                                    style={{
                                                        background: warn ? 'rgba(245,158,11,0.10)' : 'var(--bg-card-hover)',
                                                        borderColor: warn ? 'rgba(245,158,11,0.45)' : 'var(--border-secondary)',
                                                        color: 'var(--text-secondary)',
                                                    }}>
                                                    <span className="font-bold" style={{ color: a.color }}>{a.short}</span>
                                                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{v.value}</span>
                                                    <span>{v.unit}</span>
                                                    {warn && <span className="font-bold text-amber-600 dark:text-amber-400">{flag === 'high' ? '↑' : '↓'}</span>}
                                                </span>
                                            );
                                        })}
                                    </div>
                                    {row.note && <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{row.note}</p>}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
};

export default BloodView;
