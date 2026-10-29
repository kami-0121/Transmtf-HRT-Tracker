/**
 * Blood-test (lab panel) catalog and storage helpers.
 *
 * A `BloodReport` is one blood draw holding any number of analytes. Estradiol
 * is deliberately NOT stored here: a report's E2 value lives in the existing
 * `labResults` list under the SAME id, so the PK calibration layers keep a
 * single E2 source of truth. Everything else (liver, kidney, electrolytes,
 * other hormones, lipids, blood count) is stored in `values`.
 *
 * Each analyte has a canonical unit (values are converted to it for charts and
 * reference ranges) plus alternative units with a multiplicative factor
 * `canonical = value × factor`. Reference ranges are typical adult ranges for
 * orientation only — each lab's own range takes precedence.
 */
import { v4 as uuidv4 } from 'uuid';
import type { LabResult } from '../../types';

export const BLOOD_REPORTS_KEY = 'hrt-blood-reports';

export type AnalyteCategory = 'hormone' | 'liver' | 'kidney' | 'electrolyte' | 'metabolic' | 'blood';

export const ANALYTE_CATEGORY_ORDER: AnalyteCategory[] = ['hormone', 'liver', 'kidney', 'electrolyte', 'metabolic', 'blood'];

export interface AnalyteUnit {
    unit: string;
    /** canonical = value × factor */
    factor: number;
}

export interface AnalyteSpec {
    id: string;
    category: AnalyteCategory;
    /** Short label shown everywhere (abbreviation); the long name is translated via `blood.analyte.<id>`. */
    short: string;
    units: AnalyteUnit[]; // first entry = canonical unit
    refLow?: number;
    refHigh?: number;
    /** Chart / accent color. */
    color: string;
}

/** Pseudo-analyte id for estradiol (stored in labResults, not in report values). */
export const E2_ANALYTE_ID = 'e2';

export const ANALYTES: AnalyteSpec[] = [
    // ── Hormones ──
    { id: E2_ANALYTE_ID, category: 'hormone', short: 'E2', units: [{ unit: 'pg/mL', factor: 1 }, { unit: 'pmol/L', factor: 1 / 3.671 }], refLow: 100, refHigh: 200, color: '#ec4899' },
    { id: 'testosterone', category: 'hormone', short: 'T', units: [{ unit: 'ng/dL', factor: 1 }, { unit: 'nmol/L', factor: 28.842 }, { unit: 'ng/mL', factor: 100 }], refHigh: 50, color: '#6366f1' },
    { id: 'freeT', category: 'hormone', short: 'Free T', units: [{ unit: 'pg/mL', factor: 1 }, { unit: 'pmol/L', factor: 0.28842 }], color: '#818cf8' },
    { id: 'lh', category: 'hormone', short: 'LH', units: [{ unit: 'IU/L', factor: 1 }, { unit: 'mIU/mL', factor: 1 }], color: '#0ea5e9' },
    { id: 'fsh', category: 'hormone', short: 'FSH', units: [{ unit: 'IU/L', factor: 1 }, { unit: 'mIU/mL', factor: 1 }], color: '#06b6d4' },
    { id: 'prolactin', category: 'hormone', short: 'PRL', units: [{ unit: 'ng/mL', factor: 1 }, { unit: 'mIU/L', factor: 1 / 21.2 }, { unit: 'µg/L', factor: 1 }], refHigh: 25, color: '#f97316' },
    { id: 'progesterone', category: 'hormone', short: 'P4', units: [{ unit: 'ng/mL', factor: 1 }, { unit: 'nmol/L', factor: 0.3145 }], color: '#a855f7' },
    { id: 'shbg', category: 'hormone', short: 'SHBG', units: [{ unit: 'nmol/L', factor: 1 }], color: '#14b8a6' },
    { id: 'tsh', category: 'hormone', short: 'TSH', units: [{ unit: 'mIU/L', factor: 1 }, { unit: 'µIU/mL', factor: 1 }], refLow: 0.4, refHigh: 4.0, color: '#84cc16' },
    // ── Liver ──
    { id: 'alt', category: 'liver', short: 'ALT', units: [{ unit: 'U/L', factor: 1 }], refHigh: 40, color: '#f59e0b' },
    { id: 'ast', category: 'liver', short: 'AST', units: [{ unit: 'U/L', factor: 1 }], refHigh: 40, color: '#eab308' },
    { id: 'ggt', category: 'liver', short: 'GGT', units: [{ unit: 'U/L', factor: 1 }], refHigh: 50, color: '#d97706' },
    { id: 'alp', category: 'liver', short: 'ALP', units: [{ unit: 'U/L', factor: 1 }], refLow: 40, refHigh: 130, color: '#ca8a04' },
    { id: 'tbil', category: 'liver', short: 'T-Bil', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'µmol/L', factor: 1 / 17.1 }], refLow: 0.2, refHigh: 1.2, color: '#b45309' },
    { id: 'albumin', category: 'liver', short: 'ALB', units: [{ unit: 'g/dL', factor: 1 }, { unit: 'g/L', factor: 0.1 }], refLow: 3.5, refHigh: 5.0, color: '#a16207' },
    // ── Kidney ──
    { id: 'creatinine', category: 'kidney', short: 'Cr', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'µmol/L', factor: 1 / 88.4 }], refLow: 0.5, refHigh: 1.2, color: '#3b82f6' },
    { id: 'egfr', category: 'kidney', short: 'eGFR', units: [{ unit: 'mL/min/1.73m²', factor: 1 }], refLow: 90, color: '#2563eb' },
    { id: 'bun', category: 'kidney', short: 'BUN', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'mmol/L', factor: 2.801 }], refLow: 7, refHigh: 20, color: '#1d4ed8' },
    { id: 'uricAcid', category: 'kidney', short: 'UA', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'µmol/L', factor: 1 / 59.48 }], refLow: 2.5, refHigh: 7.0, color: '#60a5fa' },
    // ── Electrolytes ──
    { id: 'sodium', category: 'electrolyte', short: 'Na', units: [{ unit: 'mmol/L', factor: 1 }, { unit: 'mEq/L', factor: 1 }], refLow: 135, refHigh: 145, color: '#10b981' },
    { id: 'potassium', category: 'electrolyte', short: 'K', units: [{ unit: 'mmol/L', factor: 1 }, { unit: 'mEq/L', factor: 1 }], refLow: 3.5, refHigh: 5.0, color: '#059669' },
    { id: 'chloride', category: 'electrolyte', short: 'Cl', units: [{ unit: 'mmol/L', factor: 1 }, { unit: 'mEq/L', factor: 1 }], refLow: 98, refHigh: 107, color: '#34d399' },
    { id: 'calcium', category: 'electrolyte', short: 'Ca', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'mmol/L', factor: 4.008 }], refLow: 8.6, refHigh: 10.3, color: '#047857' },
    // ── Metabolic / lipids ──
    { id: 'glucose', category: 'metabolic', short: 'GLU', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'mmol/L', factor: 18.016 }], refLow: 70, refHigh: 99, color: '#ef4444' },
    { id: 'hba1c', category: 'metabolic', short: 'HbA1c', units: [{ unit: '%', factor: 1 }], refHigh: 5.6, color: '#dc2626' },
    { id: 'cholesterol', category: 'metabolic', short: 'TC', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'mmol/L', factor: 38.67 }], refHigh: 200, color: '#f43f5e' },
    { id: 'ldl', category: 'metabolic', short: 'LDL', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'mmol/L', factor: 38.67 }], refHigh: 130, color: '#e11d48' },
    { id: 'hdl', category: 'metabolic', short: 'HDL', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'mmol/L', factor: 38.67 }], refLow: 40, color: '#fb7185' },
    { id: 'triglycerides', category: 'metabolic', short: 'TG', units: [{ unit: 'mg/dL', factor: 1 }, { unit: 'mmol/L', factor: 88.57 }], refHigh: 150, color: '#be123c' },
    // ── Blood count ──
    { id: 'hemoglobin', category: 'blood', short: 'Hb', units: [{ unit: 'g/dL', factor: 1 }, { unit: 'g/L', factor: 0.1 }], refLow: 12, refHigh: 17, color: '#b91c1c' },
    { id: 'hematocrit', category: 'blood', short: 'Hct', units: [{ unit: '%', factor: 1 }], refLow: 36, refHigh: 50, color: '#991b1b' },
    { id: 'platelets', category: 'blood', short: 'PLT', units: [{ unit: '10³/µL', factor: 1 }, { unit: '10⁹/L', factor: 1 }], refLow: 150, refHigh: 400, color: '#7f1d1d' },
    { id: 'wbc', category: 'blood', short: 'WBC', units: [{ unit: '10³/µL', factor: 1 }, { unit: '10⁹/L', factor: 1 }], refLow: 4, refHigh: 10, color: '#9f1239' },
];

const ANALYTE_BY_ID = new Map(ANALYTES.map(a => [a.id, a]));

export const getAnalyte = (id: string): AnalyteSpec | undefined => ANALYTE_BY_ID.get(id);

export interface BloodValue {
    value: number;
    unit: string;
}

export interface BloodReport {
    id: string;
    timeH: number;
    /** analyte id → value in the unit the user entered (E2 excluded, see above). */
    values: Record<string, BloodValue>;
    note?: string;
}

/** Convert an entered value to the analyte's canonical unit (null if unknown). */
export const toCanonical = (analyteId: string, v: BloodValue): number | null => {
    const spec = getAnalyte(analyteId);
    if (!spec) return null;
    const u = spec.units.find(x => x.unit === v.unit);
    if (!u || !Number.isFinite(v.value)) return null;
    return v.value * u.factor;
};

export type RangeFlag = 'low' | 'high' | 'normal' | null;

/** Compare a canonical value with the analyte's orientation range. */
export const rangeFlag = (analyteId: string, canonical: number | null): RangeFlag => {
    const spec = getAnalyte(analyteId);
    if (!spec || canonical === null) return null;
    if (spec.refLow === undefined && spec.refHigh === undefined) return null;
    if (spec.refLow !== undefined && canonical < spec.refLow) return 'low';
    if (spec.refHigh !== undefined && canonical > spec.refHigh) return 'high';
    return 'normal';
};

/** Human-readable reference range in the canonical unit, or '' when none. */
export const formatRefRange = (spec: AnalyteSpec): string => {
    const u = spec.units[0].unit;
    if (spec.refLow !== undefined && spec.refHigh !== undefined) return `${spec.refLow}–${spec.refHigh} ${u}`;
    if (spec.refHigh !== undefined) return `< ${spec.refHigh} ${u}`;
    if (spec.refLow !== undefined) return `> ${spec.refLow} ${u}`;
    return '';
};

const LAB_UNIT_TO_E2: Record<LabResult['unit'], string> = { 'pg/ml': 'pg/mL', 'pmol/l': 'pmol/L' };
const E2_UNIT_TO_LAB: Record<string, LabResult['unit']> = { 'pg/mL': 'pg/ml', 'pmol/L': 'pmol/l' };

/** E2 value of a lab result expressed as a BloodValue. */
export const labResultToBloodValue = (lab: LabResult): BloodValue => ({
    value: lab.concValue,
    unit: LAB_UNIT_TO_E2[lab.unit] ?? 'pg/mL',
});

/** Build the linked E2 LabResult for a report (same id → calibration source). */
export const bloodValueToLabResult = (id: string, timeH: number, v: BloodValue): LabResult => ({
    id,
    timeH,
    concValue: v.value,
    unit: E2_UNIT_TO_LAB[v.unit] ?? 'pg/ml',
});

/**
 * A unified view row: a blood report, optionally carrying the E2 lab result
 * that shares its id. Legacy E2-only lab results (no report) appear as rows
 * with empty `values`, so the history shows one combined timeline.
 */
export interface BloodRow {
    id: string;
    timeH: number;
    values: Record<string, BloodValue>; // includes 'e2' when present
    note?: string;
    hasReport: boolean;
}

export const buildBloodRows = (reports: BloodReport[], labResults: LabResult[]): BloodRow[] => {
    const labById = new Map(labResults.map(l => [l.id, l]));
    const rows: BloodRow[] = [];
    const seen = new Set<string>();
    for (const r of reports) {
        const values: Record<string, BloodValue> = { ...r.values };
        const lab = labById.get(r.id);
        if (lab) values[E2_ANALYTE_ID] = labResultToBloodValue(lab);
        rows.push({ id: r.id, timeH: r.timeH, values, note: r.note, hasReport: true });
        seen.add(r.id);
    }
    for (const lab of labResults) {
        if (seen.has(lab.id)) continue;
        rows.push({ id: lab.id, timeH: lab.timeH, values: { [E2_ANALYTE_ID]: labResultToBloodValue(lab) }, hasReport: false });
    }
    return rows.sort((a, b) => b.timeH - a.timeH);
};

/** Time series (canonical unit) of one analyte across all rows, ascending. */
export const analyteSeries = (rows: BloodRow[], analyteId: string): { timeH: number; value: number }[] => {
    const out: { timeH: number; value: number }[] = [];
    for (const row of rows) {
        const v = row.values[analyteId];
        if (!v) continue;
        const c = toCanonical(analyteId, v);
        if (c !== null) out.push({ timeH: row.timeH, value: c });
    }
    return out.sort((a, b) => a.timeH - b.timeH);
};

// ── validation (storage / sync / import) ──

const isRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

export const sanitizeBloodReport = (v: unknown): BloodReport | null => {
    if (!isRecord(v)) return null;
    const id = typeof v.id === 'string' && v.id ? v.id : null;
    const timeH = typeof v.timeH === 'number' && Number.isFinite(v.timeH) ? v.timeH : null;
    if (!id || timeH === null || !isRecord(v.values)) return null;
    const values: Record<string, BloodValue> = {};
    for (const [key, raw] of Object.entries(v.values)) {
        const spec = getAnalyte(key);
        if (!spec || key === E2_ANALYTE_ID || !isRecord(raw)) continue;
        const value = raw.value;
        const unit = raw.unit;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
        if (typeof unit !== 'string' || !spec.units.some(u => u.unit === unit)) continue;
        values[key] = { value, unit };
    }
    const note = typeof v.note === 'string' && v.note.trim() ? v.note.slice(0, 500) : undefined;
    return note ? { id, timeH, values, note } : { id, timeH, values };
};

export const sanitizeBloodReports = (list: unknown): BloodReport[] => {
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: BloodReport[] = [];
    for (const item of list) {
        const r = sanitizeBloodReport(item);
        if (!r) continue;
        if (seen.has(r.id)) r.id = uuidv4();
        seen.add(r.id);
        out.push(r);
    }
    return out;
};

export const readBloodReports = (): BloodReport[] => {
    try {
        const raw = localStorage.getItem(BLOOD_REPORTS_KEY);
        return raw ? sanitizeBloodReports(JSON.parse(raw)) : [];
    } catch {
        return [];
    }
};
