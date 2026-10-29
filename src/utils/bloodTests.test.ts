import { describe, it, expect } from 'vitest';
import {
    ANALYTES, buildBloodRows, analyteSeries, toCanonical, rangeFlag, sanitizeBloodReports,
    bloodValueToLabResult, E2_ANALYTE_ID,
} from './bloodTests';
import { sanitizeRegimens, regimenToEvent, eventToRegimen } from './regimens';
import { Route, Ester, ExtraKey } from '../../types';

describe('blood test catalog', () => {
    it('has unique ids and a canonical unit with factor 1 first', () => {
        const ids = ANALYTES.map(a => a.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const a of ANALYTES) expect(a.units[0].factor).toBe(1);
    });

    it('converts alternative units to canonical', () => {
        expect(toCanonical('creatinine', { value: 88.4, unit: 'µmol/L' })).toBeCloseTo(1, 6);
        expect(toCanonical('testosterone', { value: 1, unit: 'nmol/L' })).toBeCloseTo(28.842, 3);
        expect(toCanonical(E2_ANALYTE_ID, { value: 367.1, unit: 'pmol/L' })).toBeCloseTo(100, 3);
        expect(toCanonical('potassium', { value: 4, unit: 'bogus' })).toBeNull();
    });

    it('flags values outside the reference range', () => {
        expect(rangeFlag('potassium', 5.5)).toBe('high');
        expect(rangeFlag('potassium', 3.0)).toBe('low');
        expect(rangeFlag('potassium', 4.2)).toBe('normal');
        expect(rangeFlag('lh', 5)).toBeNull(); // no range
    });
});

describe('blood rows (reports + linked E2 lab results)', () => {
    const reports = [{ id: 'r1', timeH: 100, values: { potassium: { value: 4.4, unit: 'mmol/L' } } }];
    const labs = [
        bloodValueToLabResult('r1', 100, { value: 150, unit: 'pg/mL' }),
        { id: 'legacy', timeH: 50, concValue: 400, unit: 'pmol/l' as const },
    ];

    it('merges the report E2 by id and keeps legacy E2-only labs as rows', () => {
        const rows = buildBloodRows(reports, labs);
        expect(rows.map(r => r.id)).toEqual(['r1', 'legacy']); // newest first
        expect(rows[0].values[E2_ANALYTE_ID]).toEqual({ value: 150, unit: 'pg/mL' });
        expect(rows[0].values.potassium.value).toBe(4.4);
        expect(rows[1].hasReport).toBe(false);
        expect(rows[1].values[E2_ANALYTE_ID]).toEqual({ value: 400, unit: 'pmol/L' });
    });

    it('builds an ascending canonical series', () => {
        const series = analyteSeries(buildBloodRows(reports, labs), E2_ANALYTE_ID);
        expect(series.map(p => p.timeH)).toEqual([50, 100]);
        expect(series[0].value).toBeCloseTo(400 / 3.671, 3);
    });

    it('sanitizes stored reports: drops unknown analytes/units, E2 and bad rows', () => {
        const out = sanitizeBloodReports([
            { id: 'a', timeH: 1, values: { potassium: { value: 4, unit: 'mmol/L' }, nope: { value: 1, unit: 'x' }, e2: { value: 100, unit: 'pg/mL' }, alt: { value: 20, unit: 'IU' } } },
            { id: 'a', timeH: 2, values: {} },
            { timeH: 3, values: {} },
            'junk',
        ]);
        expect(out).toHaveLength(2);
        expect(Object.keys(out[0].values)).toEqual(['potassium']);
        expect(out[1].id).not.toBe('a'); // duplicate id reassigned
    });
});

describe('regimens', () => {
    it('round-trips an event and strips patch identity', () => {
        const ev = { id: 'x', route: Route.patchApply, ester: Ester.E2, timeH: 10, doseMG: 0, weightKG: 60, extras: { [ExtraKey.releaseRateUGPerDay]: 100, [ExtraKey.patchInstanceId]: 'x' } };
        const r = eventToRegimen(ev, 'reg', ' Patch ');
        expect(r.name).toBe('Patch');
        expect(r.extras[ExtraKey.patchInstanceId]).toBeUndefined();
        const logged = regimenToEvent(r, 500, 62, 'new');
        expect(logged).toMatchObject({ id: 'new', timeH: 500, weightKG: 62, route: Route.patchApply });
        expect(logged.extras[ExtraKey.patchInstanceId]).toBe('new');
    });

    it('rejects invalid route/ester combinations and patch removals', () => {
        const out = sanitizeRegimens([
            { id: '1', name: 'ok', route: 'oral', ester: 'SPL', doseMG: 50, extras: { gelSite: 'x' } },
            { id: '2', route: 'patchRemove', ester: 'E2', doseMG: 0, extras: {} },
            { id: '3', route: 'gel', ester: 'CPA', doseMG: 1, extras: {} },
            { id: '4', route: 'oral', ester: 'E2', doseMG: -1, extras: {} },
        ]);
        expect(out.map(r => r.id)).toEqual(['1']);
        expect(out[0].extras).toEqual({});
    });
});
