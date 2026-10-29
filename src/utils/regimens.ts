/**
 * Medication regimens (藥物方案): saved dose definitions (route, compound,
 * dose and route-specific extras such as the gel product — and therefore its
 * concentration — or the sublingual tier) that can be logged in one tap from
 * the overview. Cloud-synced alongside the records.
 *
 * Logging a regimen creates an ordinary DoseEvent (fresh id, current time and
 * the latest body weight), so the PK engine never needs to know about them.
 */
import { v4 as uuidv4 } from 'uuid';
import { Route, Ester, ExtraKey, type DoseEvent, type DoseEventExtras } from '../../types';
import { isRoute, isEster, getAvailableEsters } from './doseForm';

export const REGIMENS_KEY = 'hrt-regimens';

export interface Regimen {
    id: string;
    name: string;
    route: Route;
    ester: Ester;
    /** Compound dose in mg (same convention as DoseEvent.doseMG). */
    doseMG: number;
    extras: DoseEventExtras;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

const NUMERIC_EXTRA_KEYS = (Object.values(ExtraKey) as string[]).filter(
    k => k !== ExtraKey.patchInstanceId && k !== ExtraKey.patchRemovalFor
);

export const sanitizeRegimen = (v: unknown): Regimen | null => {
    if (!isRecord(v)) return null;
    if (typeof v.id !== 'string' || !v.id) return null;
    if (!isRoute(v.route) || v.route === Route.patchRemove) return null;
    if (!isEster(v.ester) || !getAvailableEsters(v.route).includes(v.ester)) return null;
    const doseMG = typeof v.doseMG === 'number' && Number.isFinite(v.doseMG) && v.doseMG >= 0 ? v.doseMG : null;
    if (doseMG === null) return null;
    const extras: Record<string, number> = {};
    if (isRecord(v.extras)) {
        for (const key of NUMERIC_EXTRA_KEYS) {
            const val = v.extras[key];
            if (typeof val === 'number' && Number.isFinite(val)) extras[key] = val;
        }
    }
    const name = typeof v.name === 'string' ? v.name.trim().slice(0, 60) : '';
    return { id: v.id, name, route: v.route, ester: v.ester, doseMG, extras: extras as DoseEventExtras };
};

export const sanitizeRegimens = (list: unknown): Regimen[] => {
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: Regimen[] = [];
    for (const item of list) {
        const r = sanitizeRegimen(item);
        if (!r) continue;
        if (seen.has(r.id)) r.id = uuidv4();
        seen.add(r.id);
        out.push(r);
    }
    return out;
};

export const readRegimens = (): Regimen[] => {
    try {
        const raw = localStorage.getItem(REGIMENS_KEY);
        return raw ? sanitizeRegimens(JSON.parse(raw)) : [];
    } catch {
        return [];
    }
};

/** Strip per-administration identity from an event so it can become a regimen. */
export const eventToRegimen = (event: DoseEvent, id: string, name: string): Regimen => {
    const extras: DoseEventExtras = { ...event.extras };
    delete extras[ExtraKey.patchInstanceId];
    delete extras[ExtraKey.patchRemovalFor];
    return { id, name: name.trim(), route: event.route, ester: event.ester, doseMG: event.doseMG, extras };
};

/** Materialise a regimen as a new dose event at `timeH` with the given weight. */
export const regimenToEvent = (r: Regimen, timeH: number, weightKG: number, id: string = uuidv4()): DoseEvent => {
    const extras: DoseEventExtras = { ...r.extras };
    // A patch application needs its own physical-patch identity (F22).
    if (r.route === Route.patchApply) extras[ExtraKey.patchInstanceId] = id;
    return { id, route: r.route, ester: r.ester, timeH, doseMG: r.doseMG, weightKG, extras };
};
