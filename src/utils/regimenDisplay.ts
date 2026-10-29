import { Route, Ester, ExtraKey, getToE2Factor, isAntiandrogen, GEL_PRODUCTS, type GelProductSpec } from '../../logic';
import type { Regimen } from './regimens';

type T = (key: string) => string;

const gelProductOf = (r: Regimen, custom: GelProductSpec[]): GelProductSpec | undefined => {
    const id = r.extras[ExtraKey.gelProductId];
    return [...GEL_PRODUCTS, ...custom].find(p => p.id === id);
};

/** The user's name for the regimen, or a generated "compound · route" label. */
export const regimenDisplayName = (r: Regimen, t: T, custom: GelProductSpec[] = []): string => {
    if (r.name) return r.name;
    if (r.route === Route.gel) {
        const p = gelProductOf(r, custom);
        return p ? (p.name || t(p.nameKey)) : t('route.gel');
    }
    return `${t(`ester.${r.ester}`)} · ${t(`route.${r.route}`)}`;
};

const trim = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3))));

/** One-line dose summary, e.g. "4 mg (3.05 mg E2) · 舌下" or "1.5 mg E2 ≈ 2.5 g @ 0.6 mg/g". */
export const formatRegimenDose = (r: Regimen, t: T, custom: GelProductSpec[] = []): string => {
    const route = t(`route.${r.route}`);
    const rate = r.extras[ExtraKey.releaseRateUGPerDay];
    if (r.route === Route.patchApply && typeof rate === 'number' && rate > 0) {
        return `${trim(rate)} µg/d · ${route}`;
    }
    if (r.route === Route.gel) {
        const p = gelProductOf(r, custom);
        const conc = p?.concentrationMGmL;
        const grams = conc && conc > 0 ? ` ≈ ${trim(r.doseMG / conc)} g @ ${trim(conc)} mg/g` : '';
        return `${trim(r.doseMG)} mg E2${grams} · ${route}`;
    }
    const base = `${trim(r.doseMG)} mg`;
    const e2 = r.ester !== Ester.E2 && !isAntiandrogen(r.ester)
        ? ` (${trim(r.doseMG * getToE2Factor(r.ester))} mg E2)`
        : '';
    return `${base}${e2} · ${route}`;
};
