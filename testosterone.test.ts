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
    testosteroneGP,
    computeTestosteroneSeries,
    ENDOGENOUS_E2_RHO_MEAN,
    POSTERIOR_DRAWS,
} from './pk';
import { replayPersonalModel, computeSimulationWithCI, computeCoupledSimulationWithCI, initPersonalModel } from './personalModel';
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

const RHO = ENDOGENOUS_E2_RHO_MEAN;
const weeklyEV = (weeks: number, dose = 5) => Array.from({ length: weeks }, (_, w) => evInjection(w * 7 * DAY, dose));

describe('testosterone suppression model', () => {
    it('target fraction: no drug → 1; E2 dose-response matches the anchors', () => {
        expect(testosteroneTargetFraction(0)).toBe(1);
        const at = (e2: number) => testosteroneTargetFraction(e2) * TESTOSTERONE_MODEL.baselineNgdL;
        expect(at(100)).toBeGreaterThan(250);
        expect(at(100)).toBeLessThan(450);
        expect(at(200)).toBeLessThan(200);
        expect(at(300)).toBeLessThan(80);
        // ηT > 0 → less suppressible
        expect(testosteroneTargetFraction(200, {}, 0.5)).toBeGreaterThan(testosteroneTargetFraction(200));
    });

    it('anti-androgens: CPA suppresses strongly, SPL modestly, BICA raises T', () => {
        expect(testosteroneTargetFraction(0, { [Ester.CPA]: 25 })).toBeLessThan(0.35);
        const spl = testosteroneTargetFraction(0, { [Ester.SPL]: 135 });
        expect(spl).toBeGreaterThan(0.65);
        expect(spl).toBeLessThan(0.9);
        expect(testosteroneTargetFraction(0, { [Ester.BICA]: 9000 })).toBeGreaterThan(1.3);
    });

    it('is only attached when requested and leaves the drug curves unchanged', () => {
        const events = weeklyEV(2);
        const off = runSimulation(events)!;
        const on = runSimulation(events, { testosterone: {} })!;
        expect(off.testosterone).toBeUndefined();
        expect(on.concPGmL_E2).toEqual(off.concPGmL_E2);
        expect(endogenousFractionAt(off, 3 * DAY)).toBe(1);
        expect(makeEndogenousE2Context(off)).toBeUndefined();
    });

    it('before treatment T/T0 is exactly 1 with no uncertainty; it falls with a lag after', () => {
        const sim = runSimulation(weeklyEV(8), { testosterone: { baselineNgdL: 600 } })!;
        const T = sim.testosterone!;
        expect(T.tFraction[0]).toBeCloseTo(1, 9);
        expect(T.fractionLogSd[0]).toBeCloseTo(0, 9);
        expect(T.endogenousFraction[0]).toBeCloseTo(1, 9);
        expect(interpolateTestosterone(sim, -12)).toBeCloseTo(600, 6);
        const day1 = interpolateTestosterone(sim, 1 * DAY)!;
        const day42 = interpolateTestosterone(sim, 42 * DAY)!;
        expect(day1).toBeGreaterThan(200);
        expect(day42).toBeLessThan(day1);
        // Under suppression the response is uncertain without labs.
        const i = sim.timeH.findIndex(t => t >= 42 * DAY);
        expect(T.fractionLogSd[i]).toBeGreaterThan(0.3);
    });

    it('endogenous multiplier keeps a non-T-coupled residual (1 − ρ) and stays ≥ it', () => {
        const sim = runSimulation(daily(Ester.CPA, 25, 60), { testosterone: {} })!;
        const f = endogenousFractionAt(sim, 50 * DAY);
        expect(f).toBeGreaterThan(1 - RHO);
        expect(f).toBeLessThan(1);
        expect(RHO).toBeGreaterThan(0.6);
        expect(RHO).toBeLessThan(0.8);
    });

    it('bicalutamide monotherapy raises T and therefore endogenous E2', () => {
        const sim = runSimulation(daily(Ester.BICA, 50, 60), { testosterone: {} })!;
        expect(endogenousFractionAt(sim, 50 * DAY)).toBeGreaterThan(1.2);
    });

    it('resolveEndogenousE2: legacy constant without context, scaled with context', () => {
        expect(resolveEndogenousE2(undefined, 0)).toBe(0);
        expect(resolveEndogenousE2(30, 0)).toBe(30);
        const ctx = { fractionAt: () => 0.5, tFractionAt: () => 0.4, tLogSdAt: () => 0, defaultBaselinePGmL: 25 };
        expect(resolveEndogenousE2(30, 0, ctx)).toBe(15);
        expect(resolveEndogenousE2(undefined, 0, ctx)).toBe(12.5);
    });
});

describe('T calibration: data cutoff (causal vs retrospective)', () => {
    const events = weeklyEV(10);
    const plain = runSimulation(events, { testosterone: {} })!;
    const labH = 40 * DAY;
    const modelT = interpolateTestosterone(plain, labH)!;
    const obs = [{ timeH: labH, ngdL: modelT * 4 }];

    it('causal: a lab drawn 10 days later does not change today\'s T (or endogenous E2)', () => {
        const cal = runSimulation(events, { testosterone: { observations: obs, mode: 'causal' } })!;
        const before = labH - 10 * DAY;
        expect(interpolateTestosterone(cal, before)! / interpolateTestosterone(plain, before)!).toBeCloseTo(1, 6);
        expect(endogenousFractionAt(cal, before)).toBeCloseTo(endogenousFractionAt(plain, before), 6);
        // …but it does from the lab onward.
        expect(interpolateTestosterone(cal, labH + DAY)!).toBeGreaterThan(modelT * 2);
    });

    it('retrospective: the same lab reshapes the earlier estimate (smoothing)', () => {
        const cal = runSimulation(events, { testosterone: { observations: obs, mode: 'retrospective' } })!;
        const before = labH - 10 * DAY;
        expect(interpolateTestosterone(cal, before)! / interpolateTestosterone(plain, before)!).toBeGreaterThan(1.5);
    });

    it('GP: posterior passes near a lab, variance shrinks there and relaxes far away', () => {
        const r = testosteroneGP([0], [Math.log(0.5)], [1], [0, 10 * DAY, 400 * DAY], [1, 1, 1], 0.35, 'retrospective');
        expect(Math.exp(r.totalMean[0])).toBeLessThan(0.62);
        expect(r.totalVar[0]).toBeLessThan(0.1);
        expect(Math.abs(r.totalMean[2])).toBeLessThan(Math.abs(r.totalMean[0]));
        expect(r.rVar[2]).toBeGreaterThan(0.6);
        // Causal at a time before the lab = prior.
        const c = testosteroneGP([5], [1], [1], [0], [1], 0.35, 'causal');
        expect(c.totalMean[0]).toBe(0);
    });

    it('pre-treatment labs inform the personal T0, not T/T0', () => {
        const pre = [{ timeH: -10 * DAY, ngdL: 380 }, { timeH: -5 * DAY, ngdL: 400 }];
        const sim = runSimulation(events, { testosterone: { observations: pre } })!;
        const T = sim.testosterone!;
        expect(T.baselineSource).toBe('lab');
        expect(T.baselineNgdL).toBeGreaterThan(370);
        expect(T.baselineNgdL).toBeLessThan(420);
        expect(T.tFraction[0]).toBeCloseTo(1, 6);
        expect(runSimulation(events, { testosterone: { baselineNgdL: 700 } })!.testosterone!.baselineSource).toBe('setting');
    });

    it('ηT is only estimated with ≥ 2 post-treatment labs', () => {
        const one = runSimulation(events, { testosterone: { observations: obs } })!.testosterone!;
        expect(one.etaTEstimated).toBe(false);
        expect(one.etaT).toBe(0);
        const two = runSimulation(events, { testosterone: { observations: [...obs, { timeH: 60 * DAY, ngdL: interpolateTestosterone(plain, 60 * DAY)! * 4 }] } })!.testosterone!;
        expect(two.etaTEstimated).toBe(true);
        expect(two.etaT).toBeGreaterThan(0); // labs above the model → less suppressible
        expect(two.etaTSd).toBeLessThanOrEqual(T_CAL_PRIOR_SD);
    });
});
const T_CAL_PRIOR_SD = 0.5;

describe('endogenous E2 in the E2 calibration', () => {
    const events: DoseEvent[] = [...daily(Ester.CPA, 12.5, 60, 0), ...daily(Ester.E2, 2, 60, 0)];
    const pre: LabResult = { id: 'pre', timeH: -2 * DAY, concValue: 30, unit: 'pg/ml' };
    const simOn = runSimulation(events, { testosterone: {}, endTimeH: 60 * DAY })!;
    const simOff = runSimulation(events, { endTimeH: 60 * DAY })!;
    const labH = 45 * DAY + 4;
    const drugAtLab = interpolateConcentration_E2(simOn, labH)!;
    const endo = makeEndogenousE2Context(simOn)!;
    const post: LabResult = { id: 'post', timeH: labH, concValue: drugAtLab + 30 * endo.fractionAt(labH), unit: 'pg/ml' };
    const labs = [pre, post];

    it('EKF subtracts the suppressed (not the full) baseline from post-dose labs', () => {
        expect(endo.tFractionAt(labH)).toBeLessThan(0.3);
        const withT = replayPersonalModel(events, labs, endo);
        const legacy = replayPersonalModel(events, labs);
        expect(withT.baselinePGmL).toBeCloseTo(30, 6);
        expect(withT.thetaMean[0]).toBeGreaterThan(legacy.thetaMean[0]);
    });

    it('central line = drug + posterior-mean endogenous E2', () => {
        const state = replayPersonalModel(events, labs, endo);
        const ciOn = computeSimulationWithCI(simOn, events, state, false, labs, 'ekf');
        const ciOff = computeSimulationWithCI(simOff, events, state, false, labs, 'ekf');
        const i = simOn.timeH.findIndex(t => t >= 50 * DAY);
        // Monte-Carlo mean of the endogenous part ≈ B·E[multiplier] (shared draws).
        expect(ciOn.endogenousMean[i]).toBeGreaterThan(30 * (1 - RHO) * 0.9);
        expect(ciOn.endogenousMean[i]).toBeLessThan(30 * 0.6);
        expect(ciOn.e2Adjusted[i]).toBeCloseTo(ciOn.e2DrugPersonal[i] + ciOn.endogenousMean[i], 6);
        expect(ciOff.e2Adjusted[i] - ciOff.e2DrugPersonal[i]).toBeCloseTo(30, 6);
    });

    it('T uncertainty widens the E2 band (propagated through shared draws)', () => {
        const state = replayPersonalModel(events, labs, endo);
        const ci = computeSimulationWithCI(simOn, events, state, false, labs, 'ekf');
        // Same sim with T uncertainty removed.
        const T = simOn.testosterone!;
        const certain = { ...simOn, testosterone: { ...T, fractionLogSd: T.fractionLogSd.map(() => 0) } };
        const ci0 = computeSimulationWithCI(certain, events, state, false, labs, 'ekf');
        const i = simOn.timeH.findIndex(t => t >= 50 * DAY);
        expect(ci.ci95High[i] - ci.ci95Low[i]).toBeGreaterThan(ci0.ci95High[i] - ci0.ci95Low[i]);
        expect(POSTERIOR_DRAWS).toBeGreaterThanOrEqual(200);
    });

    it('OU-Kalman and Hybrid-MIPD stay finite and drop the suppressed baseline', () => {
        for (const model of ['ou-kalman', 'hybrid-mipd'] as const) {
            const ciOn = computeSimulationWithCI(simOn, events, replayPersonalModel(events, labs, endo), false, labs, model);
            const ciOff = computeSimulationWithCI(simOff, events, replayPersonalModel(events, labs), false, labs, model);
            const i = simOn.timeH.findIndex(t => t >= 50 * DAY);
            expect(Number.isFinite(ciOn.e2Adjusted[i])).toBe(true);
            expect(ciOn.e2Adjusted[i]).toBeLessThan(ciOff.e2Adjusted[i]);
        }
    });

    it('MIPD uses the population default baseline when there is no pre-dose lab', () => {
        const fit = fitMipd(events, [post], undefined, Infinity, endo);
        expect(fit.baselinePGmL).toBe(0);
        expect(resolveEndogenousE2(fit.baselinePGmL, labH, endo))
            .toBeCloseTo(TESTOSTERONE_MODEL.defaultBaselineE2PGmL * endo.fractionAt(labH), 9);
    });
});

describe('coupled E2/T estimation', () => {
    const events: DoseEvent[] = weeklyEV(12, 5);
    const tOpts = { observations: [] as { timeH: number; ngdL: number }[] };
    const sim = runSimulation(events, { testosterone: tOpts, endTimeH: 90 * DAY })!;
    // An E2 lab far above the population curve → personalised E2 exposure ↑ → T suppressed more.
    const labH = 30 * DAY + 24;
    const popE2 = interpolateConcentration_E2(sim, labH)!;
    const labs: LabResult[] = [{ id: 'e', timeH: labH, concValue: popE2 * 2.5, unit: 'pg/ml' }];
    const state = replayPersonalModel(events, labs, makeEndogenousE2Context(sim));

    it('drives the T model with the personalised E2 and converges', () => {
        const res = computeCoupledSimulationWithCI(sim, events, state, false, labs, 'ekf', false, 'retrospective', tOpts);
        expect(res.couplingIterations).toBeGreaterThan(0);
        expect(res.couplingIterations).toBeLessThanOrEqual(3);
        const i = sim.timeH.findIndex(t => t >= 60 * DAY);
        expect(res.testosterone!.tFraction[i]).toBeLessThan(sim.testosterone!.tFraction[i]);
        expect(res.model.postDoseObservationCount).toBe(1);
    });

    it('is a no-op without the testosterone model or post-dose E2 labs', () => {
        const a = computeCoupledSimulationWithCI(sim, events, state, false, labs, 'ekf', false, 'retrospective', null);
        expect(a.couplingIterations).toBe(0);
        const b = computeCoupledSimulationWithCI(sim, events, initPersonalModel(), false, [], 'ekf', false, 'retrospective', tOpts);
        expect(b.couplingIterations).toBe(0);
    });

    it('causal coupling: a later E2 lab does not move earlier T', () => {
        const later: LabResult[] = [...labs, { id: 'late', timeH: 70 * DAY, concValue: popE2 * 5, unit: 'pg/ml' }];
        const st2 = replayPersonalModel(events, later, makeEndogenousE2Context(sim));
        const a = computeCoupledSimulationWithCI(sim, events, state, false, labs, 'ekf', false, 'causal', tOpts);
        const b = computeCoupledSimulationWithCI(sim, events, st2, false, later, 'ekf', false, 'causal', tOpts);
        const i = sim.timeH.findIndex(t => t >= 50 * DAY);
        expect(b.testosterone!.tFraction[i]).toBeCloseTo(a.testosterone!.tFraction[i], 6);
    });
});

describe('time & numerical consistency (review round 2)', () => {
    const events = weeklyEV(10);
    const plain = runSimulation(events, { testosterone: {} })!;

    it('causal: no interpolation across a calibration update (future 4× lab, 1 h before it)', () => {
        // Off-grid lab time so the two neighbouring grid points straddle it.
        const labH = 40 * DAY + 0.37;
        const obs = [{ timeH: labH, ngdL: interpolateTestosterone(plain, labH)! * 4 }];
        const cal = runSimulation(events, { testosterone: { observations: obs, mode: 'causal' } })!;
        for (const dt of [1, 0.25, 0.01]) {
            const t = labH - dt;
            // Equal up to linear-interpolation error of the reference (exact knot vs.
            // interpolated grid), i.e. no trace of the 4× lab (the leak was ×1.49).
            expect(interpolateTestosterone(cal, t)! / interpolateTestosterone(plain, t)!).toBeCloseTo(1, 5);
            expect(endogenousFractionAt(cal, t)).toBeCloseTo(endogenousFractionAt(plain, t), 5);
            expect(makeEndogenousE2Context(cal)!.tFractionAt(t)).toBeCloseTo(makeEndogenousE2Context(plain)!.tFractionAt(t), 5);
        }
        // At and after the lab the update applies immediately.
        expect(interpolateTestosterone(cal, labH)! / interpolateTestosterone(plain, labH)!).toBeGreaterThan(2);
    });

    it('causal: residuals of all visible labs use the current ηT (lab spacing does not matter)', () => {
        const t1 = 40 * DAY, v = interpolateTestosterone(plain, t1)! * 3;
        const same = runSimulation(events, { testosterone: { mode: 'causal', observations: [{ timeH: t1, ngdL: v }, { timeH: t1, ngdL: v }] } })!;
        const apart = runSimulation(events, { testosterone: { mode: 'causal', observations: [{ timeH: t1, ngdL: v }, { timeH: t1 + 0.001, ngdL: v }] } })!;
        const next = t1 + DAY;
        expect(interpolateTestosterone(apart, next)! / interpolateTestosterone(same, next)!).toBeCloseTo(1, 3);
        // …and causal agrees with retrospective once every lab is visible.
        const retro = runSimulation(events, { testosterone: { mode: 'retrospective', observations: [{ timeH: t1, ngdL: v }, { timeH: t1, ngdL: v }] } })!;
        const late = 70 * DAY;
        expect(retro.testosterone!.etaT).toBeCloseTo(same.testosterone!.etaT, 6);
        expect(interpolateTestosterone(same, late)! / interpolateTestosterone(retro, late)!).toBeCloseTo(1, 6);
    });

    it('coupled E2/T: the returned T is a fixed point of the returned E2', () => {
        const sim = runSimulation(events, { testosterone: {}, endTimeH: 80 * DAY })!;
        const labH = 30 * DAY + 24;
        const labs: LabResult[] = [{ id: 'e', timeH: labH, concValue: interpolateConcentration_E2(sim, labH)! * 2.5, unit: 'pg/ml' }];
        const tOpts = { observations: [{ timeH: 45 * DAY, ngdL: 150 }] };
        for (const mode of ['causal', 'retrospective'] as const) {
            const s = runSimulation(events, { testosterone: { ...tOpts, mode }, endTimeH: 80 * DAY })!;
            const state = replayPersonalModel(events, labs, makeEndogenousE2Context(s));
            const res = computeCoupledSimulationWithCI(s, events, state, false, labs, 'ekf', false, mode, tOpts);
            const recomputed = computeTestosteroneSeries(s.timeH, res.e2DrugPersonal, s.byCompound, { ...tOpts, mode, firstDoseH: 0 });
            let worst = 0;
            for (let i = 0; i < recomputed.values.length; i++) {
                worst = Math.max(worst, Math.abs(Math.log(recomputed.values[i] / res.testosterone!.values[i])));
            }
            expect(worst).toBeLessThan(0.005);
            expect(res.couplingResidual).toBeLessThan(0.005);
        }
    });
});
