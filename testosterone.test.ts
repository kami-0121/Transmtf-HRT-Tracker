import { describe, it, expect } from 'vitest';
import { Route, Ester, type DoseEvent, type LabResult } from './types';
import {
    runSimulation,
    isAntiandrogen,
    ANTIANDROGENS,
    pickPrimaryAntiandrogen,
    computeSpironolactoneAmount,
    SPL_PK,
    TESTOSTERONE_MODEL,
    testosteroneTargetFraction,
    makeEndogenousE2Context,
    resolveEndogenousE2,
    endogenousFractionAt,
    interpolateTestosterone,
    interpolateCompoundConcentration,
    interpolateConcentration_E2,
} from './pk';
import { replayPersonalModel, computeSimulationWithCI } from './personalModel';
import { fitMipd } from './mipd';

const DAY = 24;

function oral(id: string, timeH: number, ester: Ester, doseMG: number): DoseEvent {
    return { id, route: Route.oral, timeH, doseMG, ester, weightKG: 70, extras: {} };
}

function daily(ester: Ester, doseMG: number, days: number, startH = 0): DoseEvent[] {
    const out: DoseEvent[] = [];
    for (let d = 0; d < days; d++) out.push(oral(`${ester}-${d}`, startH + d * DAY, ester, doseMG));
    return out;
}

function evInjection(timeH: number, doseMG: number): DoseEvent {
    return { id: `ev-${timeH}`, route: Route.injection, timeH, doseMG, ester: Ester.EV, weightKG: 70, extras: {} };
}

describe('spironolactone (canrenone) PK', () => {
    const splConc = (events: DoseEvent[], h: number) => {
        let amt = 0;
        for (const e of events) if (e.timeH <= h) amt += computeSpironolactoneAmount(e.doseMG, h - e.timeH);
        return ANTIANDROGENS[Ester.SPL]!.concFromAmountMG(amt, 70);
    };

    it('is registered as an anti-androgen and not folded into the E2 channel', () => {
        expect(isAntiandrogen(Ester.SPL)).toBe(true);
        const sim = runSimulation(daily(Ester.SPL, 100, 3))!;
        expect(sim.byCompound[Ester.SPL]).toBeTruthy();
        expect(Math.max(...sim.concPGmL_E2)).toBe(0);
        expect(Math.max(...sim.byCompound[Ester.SPL]!.values)).toBeGreaterThan(0);
    });

    it('reaches a steady-state canrenone Cmax near 181 ng/mL on 100 mg/day (accept 150–215)', () => {
        const events = daily(Ester.SPL, 100, 20);
        let cmax = 0;
        let tmax = 0;
        for (let h = 15 * DAY; h <= 16 * DAY; h += 0.1) {
            const c = splConc(events, h);
            if (c > cmax) { cmax = c; tmax = h - 15 * DAY; }
        }
        expect(cmax).toBeGreaterThanOrEqual(150);
        expect(cmax).toBeLessThanOrEqual(215);
        // Label Tmax ≈ 4.3 h.
        expect(tmax).toBeGreaterThanOrEqual(3);
        expect(tmax).toBeLessThanOrEqual(5.5);
    });

    it('decays with the canrenone half-life (~16.5 h)', () => {
        const events = [oral('s', 0, Ester.SPL, 100)];
        const c1 = splConc(events, 48);
        const c2 = splConc(events, 72);
        const halfLife = Math.log(2) * 24 / Math.log(c1 / c2);
        expect(halfLife).toBeGreaterThan(15);
        expect(halfLife).toBeLessThan(18);
        expect(SPL_PK.ke).toBeCloseTo(Math.log(2) / 16.5, 9);
    });

    it('participates in primary anti-androgen selection', () => {
        const events = [oral('c', 0, Ester.CPA, 12.5), oral('s', 10, Ester.SPL, 100)];
        expect(pickPrimaryAntiandrogen(events, 20)).toBe(Ester.SPL);
        const sim = runSimulation(events)!;
        expect(interpolateCompoundConcentration(sim, Ester.SPL, 20)).toBeGreaterThan(0);
    });
});

describe('testosterone suppression model', () => {
    it('target fraction: no drug → 1; E2 dose-response matches the anchors', () => {
        expect(testosteroneTargetFraction(0)).toBe(1);
        const at = (e2: number) => testosteroneTargetFraction(e2) * TESTOSTERONE_MODEL.baselineNgdL;
        expect(at(100)).toBeGreaterThan(250);   // ≈ 350 ng/dL
        expect(at(100)).toBeLessThan(450);
        expect(at(200)).toBeLessThan(200);      // ≈ 120 ng/dL
        expect(at(300)).toBeLessThan(80);       // ≈ 50 ng/dL
        expect(at(1000)).toBeGreaterThanOrEqual(TESTOSTERONE_MODEL.minFraction * TESTOSTERONE_MODEL.baselineNgdL);
    });

    it('anti-androgens: CPA suppresses strongly, SPL modestly, BICA raises T', () => {
        const cpa = testosteroneTargetFraction(0, { [Ester.CPA]: 25 });
        const spl = testosteroneTargetFraction(0, { [Ester.SPL]: 135 });
        const bica = testosteroneTargetFraction(0, { [Ester.BICA]: 9000 });
        expect(cpa).toBeLessThan(0.35);
        expect(spl).toBeGreaterThan(0.65);
        expect(spl).toBeLessThan(0.9);
        expect(bica).toBeGreaterThan(1.3);
    });

    it('is only attached when requested and leaves the drug curves unchanged', () => {
        const events = [evInjection(0, 5), evInjection(7 * DAY, 5)];
        const off = runSimulation(events)!;
        const on = runSimulation(events, { testosterone: {} })!;
        expect(off.testosterone).toBeUndefined();
        expect(on.testosterone).toBeTruthy();
        expect(on.concPGmL_E2).toEqual(off.concPGmL_E2);
        expect(on.testosterone!.values.length).toBe(on.timeH.length);
        expect(endogenousFractionAt(off, 3 * DAY)).toBe(1);
        expect(makeEndogenousE2Context(off)).toBeUndefined();
    });

    it('T starts at baseline and falls over days (not instantly) on suppressive E2', () => {
        const events: DoseEvent[] = [];
        for (let w = 0; w < 8; w++) events.push(evInjection(w * 7 * DAY, 5));
        const sim = runSimulation(events, { testosterone: { baselineNgdL: 600 } })!;
        expect(interpolateTestosterone(sim, -12)).toBeCloseTo(600, 6);
        const day1 = interpolateTestosterone(sim, 1 * DAY)!;
        const day42 = interpolateTestosterone(sim, 42 * DAY)!;
        expect(day1).toBeGreaterThan(200);       // lag: not yet at the new steady state
        expect(day42).toBeLessThan(day1);
        // Suppression is reflected in the endogenous-E2 fraction.
        expect(endogenousFractionAt(sim, 42 * DAY)).toBeCloseTo(day42 / 600, 6);
    });

    it('bicalutamide monotherapy raises T and therefore endogenous E2', () => {
        const sim = runSimulation(daily(Ester.BICA, 50, 60), { testosterone: {} })!;
        expect(endogenousFractionAt(sim, 50 * DAY)).toBeGreaterThan(1.2);
    });

    it('resolveEndogenousE2: legacy constant without context, scaled with context', () => {
        expect(resolveEndogenousE2(undefined, 0)).toBe(0);
        expect(resolveEndogenousE2(30, 0)).toBe(30);
        const ctx = { fractionAt: () => 0.5, defaultBaselinePGmL: 25 };
        expect(resolveEndogenousE2(30, 0, ctx)).toBe(15);
        expect(resolveEndogenousE2(undefined, 0, ctx)).toBe(12.5);
    });
});

describe('testosterone model in calibration', () => {
    // Oral CPA + low-dose oral E2: T is strongly suppressed, so a pre-dose
    // baseline of 30 pg/mL should mostly vanish from later predictions.
    const events: DoseEvent[] = [
        ...daily(Ester.CPA, 12.5, 60, 0),
        ...daily(Ester.E2, 2, 60, 0),
    ];
    const pre: LabResult = { id: 'pre', timeH: -2 * DAY, concValue: 30, unit: 'pg/ml' };
    const simOn = runSimulation(events, { testosterone: {}, endTimeH: 60 * DAY })!;
    const simOff = runSimulation(events, { endTimeH: 60 * DAY })!;
    // Lab near the oral-E2 peak; "truth" = drug + suppressed endogenous part.
    const labH = 45 * DAY + 4;
    const drugAtLab = interpolateConcentration_E2(simOn, labH)!;
    const truthEndo = 30 * makeEndogenousE2Context(simOn)!.fractionAt(labH);
    const post: LabResult = { id: 'post', timeH: labH, concValue: drugAtLab + truthEndo, unit: 'pg/ml' };
    const labs = [pre, post];

    it('EKF subtracts the suppressed (not the full) baseline from post-dose labs', () => {
        const endo = makeEndogenousE2Context(simOn);
        const frac = endo!.fractionAt(labH);
        expect(frac).toBeLessThan(0.3);
        const withT = replayPersonalModel(events, labs, endo);
        const legacy = replayPersonalModel(events, labs);
        expect(withT.baselinePGmL).toBeCloseTo(30, 6);
        // Legacy subtracts 30 pg/mL from a lab that is mostly drug → theta biased low.
        expect(withT.thetaMean[0]).toBeGreaterThan(legacy.thetaMean[0]);
    });

    it('EKF personal curve adds baseline × T fraction instead of the constant baseline', () => {
        const endo = makeEndogenousE2Context(simOn)!;
        const state = replayPersonalModel(events, labs, endo);
        // Same learned state on both sims isolates the endogenous term.
        const ciOn = computeSimulationWithCI(simOn, events, state, false, labs, 'ekf');
        const ciOff = computeSimulationWithCI(simOff, events, state, false, labs, 'ekf');
        const i = simOn.timeH.findIndex(t => t >= 50 * DAY);
        const frac = endo.fractionAt(simOn.timeH[i]);
        expect(ciOff.e2Adjusted[i] - ciOn.e2Adjusted[i]).toBeCloseTo(30 * (1 - frac), 6);
    });

    it('OU-Kalman and Hybrid-MIPD stay finite and drop the suppressed baseline', () => {
        const endo = makeEndogenousE2Context(simOn);
        for (const model of ['ou-kalman', 'hybrid-mipd'] as const) {
            const ciOn = computeSimulationWithCI(simOn, events, replayPersonalModel(events, labs, endo), false, labs, model);
            const ciOff = computeSimulationWithCI(simOff, events, replayPersonalModel(events, labs), false, labs, model);
            const i = simOn.timeH.findIndex(t => t >= 50 * DAY);
            expect(Number.isFinite(ciOn.e2Adjusted[i])).toBe(true);
            expect(ciOn.e2Adjusted[i]).toBeLessThan(ciOff.e2Adjusted[i]);
        }
    });

    it('MIPD uses the population default baseline when there is no pre-dose lab', () => {
        const endo = makeEndogenousE2Context(simOn);
        const fit = fitMipd(events, [post], undefined, Infinity, endo);
        expect(fit.baselinePGmL).toBe(0); // no pre-dose lab → resolved via context default
        expect(resolveEndogenousE2(fit.baselinePGmL, labH, endo))
            .toBeCloseTo(TESTOSTERONE_MODEL.defaultBaselineE2PGmL * endo!.fractionAt(labH), 9);
    });
});
