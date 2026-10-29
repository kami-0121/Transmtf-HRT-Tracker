import { Route, Ester, type DoseEvent, type LabResult, type SimulationResult, type TestosteroneSeries } from './types';
import {
    CorePK,
    CPA_2COMP_PK,
    resolveParams,
    compute2CompCPACentralAmount,
    _analytic3C,
    oneCompAmount,
    gelEventCentralAmount,
    weightAtTimeH,
    isAntiandrogen,
    ANTIANDROGENS,
    ANTIANDROGEN_ESTERS,
    findPatchRemovalForApply,
    makeEndogenousE2Context,
    resolveEndogenousE2,
    sampleEndogenousE2,
    computeTestosteroneSeries,
    type TestosteroneModelOptions,
    POSTERIOR_DRAWS,
    SHARED_DRAWS,
    type EndogenousE2Context,
} from './pk';
import {
    convertToPgMl,
    buildOUKalmanCalibration,
    OU_DEFAULT_PARAMS,
    type CalibrationModel,
    type CalibrationMode,
} from './calibration';
import {
    fitMipd,
    fitMipdTimeline,
    makeMipdResolver,
    mipdPredict,
    MIPD_DEFAULT_PRIOR,
    GP_RESIDUAL_DEFAULT,
} from './mipd';

export interface ResidualAnchor {
    timeH: number;
    logRatio: number;
    w: number;
    kind: 'lab';
}

export interface PersonalModelState {
    modelVersion: 'pk-ekf-v1';
    thetaMean: [number, number];
    thetaCov: [[number, number], [number, number]];
    Q: [[number, number], [number, number]];
    Rlog: number;
    anchors: ResidualAnchor[];
    /** Total number of lab results processed (pre-dose + post-dose). */
    observationCount: number;
    /**
     * Number of lab results recorded **after** the first medication dose.
     * Only post-dose observations drive EKF parameter learning; this counter
     * is therefore the correct gate for enabling personalised CI bands.
     */
    postDoseObservationCount: number;
    updatedAt: string;
    /**
     * Endogenous / pre-treatment baseline E2 in pg/mL derived from lab results
     * that were recorded before the first medication dose. When non-zero this
     * value is added to every drug-derived E2 estimate so the simulated curve
     * sits on top of the individual's background level rather than zero.
     */
    baselinePGmL?: number;
}

export interface EKFDiagnostics {
    NIS: number;
    isOutlier: boolean;
    residualLog: number;
    predictedPGmL: number;
    observedPGmL: number;
    ci95Low: number;
    ci95High: number;
    convergenceScore: number;
    thetaS: number;
    thetaK: number;
}

const EKF_INITIAL_COV: [[number, number], [number, number]] = [[0.25, 0.0], [0.0, 0.09]];
const EKF_Q: [[number, number], [number, number]] = [[0.0004, 0.0], [0.0, 0.0001]];
const EKF_RLOG = 0.04;
const EKF_EPS = 0.1;
const EKF_EPS_CPA = 0.001;
const EKF_CHI2_95 = 3.841;
const EKF_DELTA_K = 0.01;
const EKF_CI_MAX_E2 = 5000;
/** Model ceiling for the personalised E2 curve (pg/mL). Exported so display layers (OverviewView) can flag "at/above ceiling" instead of silently swapping sources (F13). */
export const PERSONAL_E2_CEILING_PGML = EKF_CI_MAX_E2;
const EKF_SIGMA_RESIDUAL_LOG = 0.27;
const EKF_Q_REF_PERIOD_H = 30 * 24;

const CPA_E2_INHIBITION = {
    Emax: 0.20,
    IC50: 50.0,
    n: 1.0,
};

/** Initialise a new personal model state at the population prior. */
export function initPersonalModel(): PersonalModelState {
    return {
        modelVersion: 'pk-ekf-v1',
        thetaMean: [0, 0],
        thetaCov: EKF_INITIAL_COV,
        Q: EKF_Q,
        Rlog: EKF_RLOG,
        anchors: [],
        observationCount: 0,
        postDoseObservationCount: 0,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * Compute the E2-family amount contributed by a single event with a scaled
 * clearance rate. CPA is excluded here because its PK is modeled separately.
 */
function computeEventAmountWithKScale(
    event: DoseEvent,
    allEvents: DoseEvent[],
    tau: number,
    kScale: number
): number {
    if (tau < 0) return 0;
    if (event.route === Route.patchRemove) return 0;
    if (isAntiandrogen(event.ester)) return 0;

    const params = resolveParams(event);
    const k3 = params.k3 * kScale;

    switch (event.route) {
        case Route.injection: {
            const doseFast = event.doseMG * params.Frac_fast;
            const doseSlow = event.doseMG * (1.0 - params.Frac_fast);
            return _analytic3C(tau, doseFast, params.F, params.k1_fast, params.k2, k3) +
                   _analytic3C(tau, doseSlow, params.F, params.k1_slow, params.k2, k3);
        }
        case Route.gel:
            // Layered transdermal model, resolved from the gel product registry;
            // the EKF clearance scale flows in through k3.
            return gelEventCentralAmount(event, tau, k3);
        case Route.oral: {
            const paramsK = { ...params, k3 };
            return oneCompAmount(tau, event.doseMG, paramsK);
        }
        case Route.sublingual: {
            const doseFast = event.doseMG * params.Frac_fast;
            const doseSlow = event.doseMG * (1.0 - params.Frac_fast);
            if (params.k2 > 0) {
                return _analytic3C(tau, doseFast, params.F_fast, params.k1_fast, params.k2, k3) +
                       _analytic3C(tau, doseSlow, params.F_slow, params.k1_slow, params.k2, k3);
            }

            const branch = (dose: number, bioavailability: number, ka: number, ke: number, t: number): number => {
                if (Math.abs(ka - ke) < 1e-9) return dose * bioavailability * ka * t * Math.exp(-ke * t);
                return dose * bioavailability * ka / (ka - ke) * (Math.exp(-ke * t) - Math.exp(-ka * t));
            };
            return branch(doseFast, params.F_fast, params.k1_fast, k3, tau) +
                   branch(doseSlow, params.F_slow, params.k1_slow, k3, tau);
        }
        case Route.patchApply: {
            // F22: pair with the removal that TARGETS this physical patch;
            // legacy removals without a target keep the old first-removal
            // rule (shared helper, identical to pk.ts / mipd.ts).
            const remove = findPatchRemovalForApply(event, allEvents);
            const wearH = (remove?.timeH ?? Number.MAX_VALUE) - event.timeH;
            if (params.rateMGh > 0) {
                if (tau <= wearH) {
                    return params.rateMGh / k3 * (1 - Math.exp(-k3 * tau));
                }
                const amtAtRemoval = params.rateMGh / k3 * (1 - Math.exp(-k3 * wearH));
                return amtAtRemoval * Math.exp(-k3 * (tau - wearH));
            }

            const paramsK = { ...params, k3 };
            const amtUnder = oneCompAmount(tau, event.doseMG, paramsK);
            if (tau > wearH) {
                const amtAtRemoval = oneCompAmount(wearH, event.doseMG, paramsK);
                return amtAtRemoval * Math.exp(-k3 * (tau - wearH));
            }
            return amtUnder;
        }
        default:
            return 0;
    }
}

function computeCPAAmountWithAdherence(
    event: DoseEvent,
    tau: number,
    adherenceScale: number
): number {
    if (tau < 0 || event.ester !== Ester.CPA) return 0;
    return compute2CompCPACentralAmount(event.doseMG * adherenceScale, tau);
}

/**
 * Compute CPA plasma concentration in ng/mL at a single time point using the
 * E2-inferred adherence scale and the fixed CPA population PK model.
 */
export function computeCPAAtTimeWithTheta(
    events: DoseEvent[],
    timeH: number,
    theta: [number, number]
): number {
    const adherence = Math.exp(theta[0]);
    const sorted = [...events].sort((a, b) => a.timeH - b.timeH);
    let totalCentralMG = 0;
    for (const event of sorted) {
        if (event.timeH > timeH) continue;
        totalCentralMG += computeCPAAmountWithAdherence(event, timeH - event.timeH, adherence);
    }
    const weight = weightAtTimeH(sorted, timeH);
    const v1mL = CPA_2COMP_PK.V1_per_kg * weight * 1000;
    return Math.max(0, (totalCentralMG * 1e6) / v1mL);
}

/**
 * Compute E2 (pg/mL) at one time from already time-sorted events, so callers
 * that evaluate the curve at many points pay the sort cost only once. Only doses
 * at or before `timeH` contribute (the curve is causal in doses by construction).
 */
function e2AtTimeWithThetaSorted(
    sortedEvents: DoseEvent[],
    timeH: number,
    theta: [number, number]
): number {
    const s = Math.exp(theta[0]);
    const kScale = Math.exp(theta[1]);

    let totalMG = 0;
    for (const event of sortedEvents) {
        if (event.timeH > timeH) break; // sorted ascending → nothing later contributes
        totalMG += computeEventAmountWithKScale(event, sortedEvents, timeH - event.timeH, kScale);
    }

    const weight = weightAtTimeH(sortedEvents, timeH);
    const plasmaVolML = CorePK.vdPerKG * weight * 1000;
    return Math.max(0, (totalMG * 1e9) / plasmaVolML * s);
}

/**
 * Compute E2 plasma concentration in pg/mL at a single time point using the
 * personalized scaling parameters theta = [theta_s, theta_k].
 */
export function computeE2AtTimeWithTheta(
    events: DoseEvent[],
    timeH: number,
    theta: [number, number]
): number {
    const sorted = [...events].sort((a, b) => a.timeH - b.timeH);
    return e2AtTimeWithThetaSorted(sorted, timeH, theta);
}

/**
 * EKF update: incorporate one new lab result into the personal model and
 * return both the updated state and diagnostics for that observation.
 */
export function ekfUpdatePersonalModel(
    events: DoseEvent[],
    state: PersonalModelState,
    labResult: LabResult,
    prevLabTimeH?: number,
    endo?: EndogenousE2Context
): { newState: PersonalModelState; diagnostics: EKFDiagnostics } {
    const hasDoseBeforeLab = events.some((ev) =>
        ev.timeH <= labResult.timeH &&
        ev.route !== Route.patchRemove &&
        !isAntiandrogen(ev.ester)
    );

    const obsPGmL = convertToPgMl(labResult.concValue, labResult.unit);

    const theta = state.thetaMean.slice() as [number, number];
    const dtH = prevLabTimeH !== undefined
        ? Math.max(24, labResult.timeH - prevLabTimeH)
        : EKF_Q_REF_PERIOD_H;
    const qScale = dtH / EKF_Q_REF_PERIOD_H;
    const P: [[number, number], [number, number]] = [
        [state.thetaCov[0][0] + state.Q[0][0] * qScale, state.thetaCov[0][1] + state.Q[0][1] * qScale],
        [state.thetaCov[1][0] + state.Q[1][0] * qScale, state.thetaCov[1][1] + state.Q[1][1] * qScale],
    ];

    const predPGmL = computeE2AtTimeWithTheta(events, labResult.timeH, theta);
    const yhat = Math.log(Math.max(predPGmL, EKF_EPS));

    if (!hasDoseBeforeLab) {
        const initialTrace = EKF_INITIAL_COV[0][0] + EKF_INITIAL_COV[1][1];
        const currentTrace = state.thetaCov[0][0] + state.thetaCov[1][1];
        const convergenceScore = Math.max(0, Math.min(1, 1 - currentTrace / initialTrace));

        // Accumulate baseline estimates using an online mean so multiple pre-dose
        // labs all contribute. Use observationCount (total, not post-dose) as the
        // running count of pre-dose observations already accumulated.
        // With the testosterone model, a "pre-dose" lab may already sit on a
        // partially suppressed axis (e.g. an anti-androgen started before E2),
        // so normalise it back to the pre-treatment baseline: B = obs / f(t).
        const fracAtLab = endo ? Math.max(endo.fractionAt(labResult.timeH), 0.05) : 1;
        const obsBaseline = obsPGmL / fracAtLab;
        const prevBaseline = state.baselinePGmL ?? 0;
        const prevCount = state.observationCount;
        const newBaselinePGmL = prevCount === 0
            ? obsBaseline
            : (prevBaseline * prevCount + obsBaseline) / (prevCount + 1);

        const baselineState: PersonalModelState = {
            ...state,
            baselinePGmL: newBaselinePGmL,
            observationCount: state.observationCount + 1,
            // postDoseObservationCount intentionally NOT incremented:
            // pre-dose labs carry no PK information and must not unlock CI bands.
            postDoseObservationCount: state.postDoseObservationCount,
            updatedAt: new Date().toISOString(),
        };
        const diagnostics: EKFDiagnostics = {
            NIS: 0,
            isOutlier: false,
            residualLog: 0,
            predictedPGmL: predPGmL,
            observedPGmL: obsPGmL,
            ci95Low: obsPGmL,
            ci95High: obsPGmL,
            convergenceScore,
            thetaS: Math.exp(state.thetaMean[0]),
            thetaK: Math.exp(state.thetaMean[1]),
        };
        return { newState: baselineState, diagnostics };
    }

    const thetaKPerturbed: [number, number] = [theta[0], theta[1] + EKF_DELTA_K];
    const predPerturbed = computeE2AtTimeWithTheta(events, labResult.timeH, thetaKPerturbed);
    const yhatPerturbed = Math.log(Math.max(predPerturbed, EKF_EPS));
    const H: [number, number] = [1.0, (yhatPerturbed - yhat) / EKF_DELTA_K];

    // Subtract the endogenous baseline before computing the innovation so that
    // EKF only learns from the drug-derived portion of the measured concentration.
    // Without this correction the baseline would be absorbed into theta (biasing
    // PK parameters upward) and then added again in computeSimulationWithCI,
    // causing a double-count of the endogenous contribution.
    // With the testosterone model the endogenous part is time-varying (it fades
    // as T is suppressed); without it this is the legacy constant baseline.
    const baseline = resolveEndogenousE2(state.baselinePGmL, labResult.timeH, endo);
    const obsDrugPGmL = Math.max(obsPGmL - baseline, EKF_EPS);
    const y = Math.log(obsDrugPGmL);

    const innovation = y - yhat;
    const S = H[0] * H[0] * P[0][0] + 2 * H[0] * H[1] * P[0][1] + H[1] * H[1] * P[1][1] + state.Rlog;
    const NIS = S > 0 ? (innovation * innovation) / S : 0;
    const isOutlier = NIS > EKF_CHI2_95;

    const Reff = isOutlier ? state.Rlog * 4.0 : state.Rlog;
    const Seff = H[0] * H[0] * P[0][0] + 2 * H[0] * H[1] * P[0][1] + H[1] * H[1] * P[1][1] + Reff;

    const K: [number, number] = [
        (P[0][0] * H[0] + P[0][1] * H[1]) / Seff,
        (P[1][0] * H[0] + P[1][1] * H[1]) / Seff,
    ];

    const thetaNew: [number, number] = [theta[0] + K[0] * innovation, theta[1] + K[1] * innovation];

    const i00 = 1 - K[0] * H[0];
    const i01 = -K[0] * H[1];
    const i10 = -K[1] * H[0];
    const i11 = 1 - K[1] * H[1];
    const PNew: [[number, number], [number, number]] = [
        [i00 * P[0][0] + i01 * P[1][0], i00 * P[0][1] + i01 * P[1][1]],
        [i10 * P[0][0] + i11 * P[1][0], i10 * P[0][1] + i11 * P[1][1]],
    ];
    PNew[0][1] = PNew[1][0] = (PNew[0][1] + PNew[1][0]) / 2;
    PNew[0][0] = Math.max(PNew[0][0], 1e-6);
    PNew[1][1] = Math.max(PNew[1][1], 1e-6);

    const newPredPGmL = computeE2AtTimeWithTheta(events, labResult.timeH, thetaNew);
    // Use the baseline-subtracted observation for the residual anchor so that
    // the anchor only captures drug-model mismatch, not endogenous E2.
    const logRatioPost = Math.log(obsDrugPGmL) - Math.log(Math.max(newPredPGmL, EKF_EPS));
    const anchor: ResidualAnchor = {
        timeH: labResult.timeH,
        logRatio: logRatioPost,
        w: isOutlier ? 0.3 : 1.0,
        kind: 'lab',
    };
    const updatedAnchors = [...state.anchors, anchor]
        .sort((a, b) => a.timeH - b.timeH)
        .slice(-20);

    const hK = H[1];
    const varYhat = PNew[0][0] + 2 * PNew[0][1] * hK + PNew[1][1] * hK * hK;
    const std95 = Math.sqrt(Math.max(0, varYhat + Reff));
    // Diagnostics CI is in drug-only space (matches what EKF was trained on).
    // The caller can add baseline on top if needed for display purposes.
    const logPredNew = Math.log(Math.max(newPredPGmL, EKF_EPS));
    const ci95Low = Math.exp(logPredNew - 1.96 * std95);
    const ci95High = Math.exp(logPredNew + 1.96 * std95);

    const initialTrace = EKF_INITIAL_COV[0][0] + EKF_INITIAL_COV[1][1];
    const currentTrace = PNew[0][0] + PNew[1][1];
    const convergenceScore = Math.max(0, Math.min(1, 1 - currentTrace / initialTrace));

    const newState: PersonalModelState = {
        modelVersion: 'pk-ekf-v1',
        thetaMean: thetaNew,
        thetaCov: PNew,
        Q: state.Q,
        Rlog: state.Rlog,
        anchors: updatedAnchors,
        observationCount: state.observationCount + 1,
        postDoseObservationCount: state.postDoseObservationCount + 1,
        // Preserve any baseline that was set by pre-dose labs.
        baselinePGmL: state.baselinePGmL,
        updatedAt: new Date().toISOString(),
    };

    const diagnostics: EKFDiagnostics = {
        NIS,
        isOutlier,
        residualLog: innovation,
        predictedPGmL: predPGmL,
        observedPGmL: obsPGmL,
        ci95Low,
        ci95High,
        convergenceScore,
        thetaS: Math.exp(thetaNew[0]),
        thetaK: Math.exp(thetaNew[1]),
    };

    return { newState, diagnostics };
}

/**
 * A personal-model state together with the time from which it becomes valid.
 * `timeH` is the lab time that produced this state; the very first snapshot uses
 * `-Infinity` (the population prior, valid before any observation exists).
 */
export interface PersonalSnapshot {
    /** Earliest time at which this state is the most up-to-date estimate. */
    timeH: number;
    state: PersonalModelState;
}

/**
 * Replay all lab results from the population prior, capturing the personal-model
 * state *after each* observation. The result is the causal timeline of the
 * model: snapshot `k` reflects only the labs at index `< k+1` (i.e. up to and
 * including lab `k`), so it can be used to estimate historical points using just
 * the information that existed at the time — without letting future labs or
 * doses rewrite the past.
 */
export function replayPersonalModelTimeline(
    events: DoseEvent[],
    labResults: LabResult[],
    endo?: EndogenousE2Context
): PersonalSnapshot[] {
    let state = initPersonalModel();
    const sorted = [...labResults].sort((a, b) => a.timeH - b.timeH);
    const snapshots: PersonalSnapshot[] = [{ timeH: -Infinity, state }];
    for (let i = 0; i < sorted.length; i++) {
        const prevTimeH = i > 0 ? sorted[i - 1].timeH : undefined;
        const { newState } = ekfUpdatePersonalModel(events, state, sorted[i], prevTimeH, endo);
        state = newState;
        snapshots.push({ timeH: sorted[i].timeH, state });
    }
    return snapshots;
}

/**
 * Replay all lab results from the population prior to rebuild the personal
 * model after events or labs are edited. Returns the *final* state (all labs
 * applied); for the per-time causal timeline use
 * {@link replayPersonalModelTimeline}.
 */
export function replayPersonalModel(
    events: DoseEvent[],
    labResults: LabResult[],
    endo?: EndogenousE2Context
): PersonalModelState {
    const timeline = replayPersonalModelTimeline(events, labResults, endo);
    return timeline[timeline.length - 1].state;
}

/**
 * Build a resolver that, given a time, returns the latest personal-model state
 * whose snapshot time is `<= timeH`. When `timeline` is null (retrospective
 * mode) the resolver always returns `fallback` — i.e. the final learned state is
 * applied to the whole curve, which is the legacy behaviour.
 */
function makeSnapshotResolver(
    timeline: PersonalSnapshot[] | null,
    fallback: PersonalModelState
): (timeH: number) => PersonalModelState {
    if (!timeline || timeline.length === 0) return () => fallback;
    return (timeH: number): PersonalModelState => {
        // timeline[0].timeH === -Infinity, so `ans` is always a valid index.
        let lo = 0;
        let hi = timeline.length - 1;
        let ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (timeline[mid].timeH <= timeH) {
                ans = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return timeline[ans].state;
    };
}

/**
 * Compute the fraction of E2 clearance inhibited by CPA at a given
 * concentration using a Hill-style saturation model.
 */
export function computeCPAE2InhibitionFactor(
    cpaNgML: number,
    params = CPA_E2_INHIBITION
): number {
    if (!Number.isFinite(cpaNgML) || cpaNgML <= 0) return 0;
    const { Emax, IC50, n } = params;
    if (!Number.isFinite(Emax) || Emax <= 0 || !Number.isFinite(IC50) || IC50 <= 0 || !Number.isFinite(n) || n <= 0) return 0;
    const Dn = Math.pow(cpaNgML, n);
    const IC50n = Math.pow(IC50, n);
    return Math.min(Math.max(0, Emax * Dn / (IC50n + Dn)), Emax * 0.9999);
}

/**
 * Compute a full simulation curve with calibration-aware E2 and adherence-aware
 * CPA estimates plus confidence intervals.
 */
export function computeSimulationWithCI(
    sim: SimulationResult,
    events: DoseEvent[],
    state: PersonalModelState,
    applyE2LearningToCPA: boolean = true,
    labResults: LabResult[] = [],
    calibrationModel: CalibrationModel = 'ekf',
    applyCPAInhibitionToE2: boolean = false,
    calibrationMode: CalibrationMode = 'retrospective',
    /**
     * Fast path for the inner E2/T coupling iterations: only `e2DrugPersonal`
     * is needed, evaluated every `strideH` hours and linearly interpolated
     * (the T turnover model, t½ ≈ 48 h, does not resolve finer structure).
     */
    fast?: { drugOnly: true; strideH: number }
): {
    timeH: number[];
    e2Adjusted: number[];
    ci95Low: number[];
    ci95High: number[];
    ci68Low: number[];
    ci68High: number[];
    /** Personalised DRUG part of E2 (point estimate, no endogenous E2) — drives the coupled T model. */
    e2DrugPersonal: number[];
    /** Posterior mean of the endogenous E2 contribution included in e2Adjusted. */
    endogenousMean: number[];
    /**
     * Causal mode: times at which the personalised curves change state (E2 lab
     * times and T calibration updates). Read the arrays with
     * interpolateNoCross so no value mixes pre- and post-update states.
     */
    updateTimesH: number[];
    antiandrogen: Partial<Record<Ester, { adjusted: number[]; ci95Low: number[]; ci95High: number[] }>>;
} {
    const n = sim.timeH.length;
    if (n === 0) {
        return {
            timeH: [],
            e2Adjusted: [],
            ci95Low: [],
            ci95High: [],
            ci68Low: [],
            ci68High: [],
            e2DrugPersonal: [],
            endogenousMean: [],
            updateTimesH: [],
            antiandrogen: {},
        };
    }

    // Temporal semantics of the personalised curve. In `causal` mode each point
    // is estimated from only the labs available up to that time (a per-lab
    // snapshot timeline), so adding later labs or doses never rewrites the past.
    // In `retrospective` mode the resolver always returns the final learned
    // `state`, i.e. the whole curve is re-fit from hindsight (legacy behaviour).
    // Endogenous E2: the simulation carries a testosterone series only when the
    // testosterone model is on; then the baseline fades with T suppression.
    const endo = makeEndogenousE2Context(sim);
    const timeline = calibrationMode === 'causal'
        ? replayPersonalModelTimeline(events, labResults, endo)
        : null;
    const resolveState = makeSnapshotResolver(timeline, state);
    // Endogenous E2 at `timeH`: the pre-dose-lab baseline (0 if none, unless the
    // testosterone model supplies a population default), scaled by T(t)/T0.
    const baselineOf = (st: PersonalModelState, timeH: number): number =>
        resolveEndogenousE2(st.baselinePGmL, timeH, endo);

    const clampCI = (low: number, high: number, hardMax: number): [number, number] => {
        const lo = Number.isFinite(low) ? Math.max(0, low) : 0;
        const hi = Number.isFinite(high) ? Math.max(lo, high) : lo;
        return [Math.min(lo, hardMax), Math.min(hi, hardMax)];
    };

    // Each calibration model yields the DRUG part of E2 as a lognormal-ish
    // posterior: a point estimate (`drugCenter`), the log-median and log-SD of
    // its band, plus the lab-derived endogenous baseline B (undefined = none).
    // The endogenous part is combined afterwards, in one place, so its
    // uncertainty is propagated identically for every model.
    const drugCenter = new Array<number>(n);
    const drugLnMid = new Array<number>(n);
    const drugSd = new Array<number>(n);
    const labBaseline = new Array<number | undefined>(n);
    const labBaselineOf = (v: number | undefined): number | undefined =>
        (v !== undefined && Number.isFinite(v) && v > 0) ? v : undefined;
    // Grid indices to evaluate: all, or a stride for the fast coupling pass.
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
        if (!fast || i === 0 || i === n - 1 || sim.timeH[i] - sim.timeH[idx[idx.length - 1]] >= fast.strideH) idx.push(i);
    }

    if (calibrationModel === 'ou-kalman') {
        // Causal → forward filter only; retrospective → forward + RTS smoother.
        // F04: pass the endogenous baseline (resolveState mirrors the EKF branch:
        // causal sees only the baseline knowable at the lab's time, retrospective
        // the final one) so the OU learns from the drug-derived lab portion only
        // instead of double-counting the baseline in the multiplier and again on
        // output below.
        const ou = buildOUKalmanCalibration(
            sim,
            labResults,
            OU_DEFAULT_PARAMS,
            calibrationMode === 'causal' ? 'forward' : 'smooth',
            { baselineAt: (timeH: number) => baselineOf(resolveState(timeH), timeH) }
        );

        for (const i of idx) {
            const c0 = Math.max(sim.concPGmL_E2[i], EKF_EPS);
            const mean = ou.m[i];
            const P = Math.max(0, ou.P[i]);
            labBaseline[i] = labBaselineOf(resolveState(sim.timeH[i]).baselinePGmL);
            drugCenter[i] = c0 * Math.exp(mean + 0.5 * P);
            drugLnMid[i] = Math.log(c0) + mean;
            drugSd[i] = Math.sqrt(P);
        }
    } else if (calibrationModel === 'hybrid-mipd') {
        // Robust MAP-Bayesian individualisation (Hybrid-MIPD): the population PK
        // model is the prior and the user's OWN labs are the likelihood. Causal
        // mode resolves a per-lab-prefix timeline of fits (future labs never
        // rewrite the past); retrospective mode fits once on all labs and applies
        // it to the whole curve. Each fit carries its own endogenous baseline.
        const sortedEvents = [...events].sort((a, b) => a.timeH - b.timeH);
        const mipdTimeline = calibrationMode === 'causal'
            ? fitMipdTimeline(events, labResults, MIPD_DEFAULT_PRIOR, endo)
            : null;
        const finalFit = fitMipd(events, labResults, MIPD_DEFAULT_PRIOR, Infinity, endo);
        const resolveMipd = makeMipdResolver(mipdTimeline, finalFit);

        for (const i of idx) {
            const timeH = sim.timeH[i];
            const fit = resolveMipd(timeH);
            const pred = mipdPredict(sortedEvents, timeH, fit, GP_RESIDUAL_DEFAULT);
            // Central line = GP-corrected MAP point prediction (the posterior
            // mode/median), the standard MIPD choice — uncertainty lives in the
            // bands, not in an upward Jensen shift of the line. This makes the
            // zero-data curve fall back exactly onto the population curve.
            const effectiveBase = Math.max(EKF_EPS, Math.max(0, pred.e2Drug) * Math.exp(pred.gpMean));
            labBaseline[i] = labBaselineOf(fit.baselinePGmL);
            drugCenter[i] = effectiveBase;
            drugLnMid[i] = Math.log(effectiveBase);
            drugSd[i] = Math.sqrt(Math.max(0, pred.varLogParam + pred.varLogResid + pred.varLogGp));
        }
    } else {
        // Evaluate the personalised E2 and CI EXACTLY at every grid point — no
        // sub-sampling or interpolation. This makes the displayed value at a given
        // time a deterministic function of (theta, doses ≤ t), so logging a dose
        // after the last lab — which leaves theta unchanged — never shifts earlier
        // points, even though runSimulation rescales the whole time grid when
        // events change. Events are sorted once and reused across all points.
        const sortedEvents = [...events].sort((a, b) => a.timeH - b.timeH);

        for (const i of idx) {
            const timeH = sim.timeH[i];
            const st = resolveState(timeH);
            const theta = st.thetaMean;
            const P = st.thetaCov;
            const e2Base = Math.max(e2AtTimeWithThetaSorted(sortedEvents, timeH, theta), EKF_EPS);
            const yhat = Math.log(e2Base);
            const thetaKPlus: [number, number] = [theta[0], theta[1] + EKF_DELTA_K];
            // Same centre formula in the fast and full paths (the Jensen term needs H1).
            const yhatPlus = Math.log(Math.max(e2AtTimeWithThetaSorted(sortedEvents, timeH, thetaKPlus), EKF_EPS));
            const H1 = (yhatPlus - yhat) / EKF_DELTA_K;
            const rawSigma2Param = P[0][0] + 2 * H1 * P[0][1] + H1 * H1 * P[1][1];
            const sigma2Param = Number.isFinite(rawSigma2Param) && rawSigma2Param > 0 ? rawSigma2Param : 0;
            labBaseline[i] = labBaselineOf(st.baselinePGmL);
            drugCenter[i] = e2Base * Math.exp(0.5 * sigma2Param);
            drugLnMid[i] = yhat;
            drugSd[i] = Math.sqrt(sigma2Param + EKF_SIGMA_RESIDUAL_LOG * EKF_SIGMA_RESIDUAL_LOG);
        }
    }

    if (fast) {
        // Fill the skipped grid points by linear interpolation and return only
        // what the coupling loop consumes.
        for (let k = 0; k + 1 < idx.length; k++) {
            const i0 = idx[k], i1 = idx[k + 1];
            for (let i = i0 + 1; i < i1; i++) {
                const w = (sim.timeH[i] - sim.timeH[i0]) / (sim.timeH[i1] - sim.timeH[i0]);
                drugCenter[i] = drugCenter[i0] + (drugCenter[i1] - drugCenter[i0]) * w;
            }
        }
        return {
            timeH: sim.timeH, e2Adjusted: [], ci95Low: [], ci95High: [], ci68Low: [], ci68High: [],
            e2DrugPersonal: drugCenter, endogenousMean: [], updateTimesH: [], antiandrogen: {},
        };
    }

    const e2Adjusted = new Array<number>(n);
    const ci95Low = new Array<number>(n);
    const ci95High = new Array<number>(n);
    const ci68Low = new Array<number>(n);
    const ci68High = new Array<number>(n);
    const endogenousMean = new Array<number>(n);

    if (!endo) {
        // Testosterone model off: legacy constant baseline, treated as known.
        for (let i = 0; i < n; i++) {
            const B = labBaseline[i] ?? 0;
            endogenousMean[i] = B;
            e2Adjusted[i] = Math.min(B + drugCenter[i], EKF_CI_MAX_E2);
            [ci95Low[i], ci95High[i]] = clampCI(
                B + Math.exp(drugLnMid[i] - 1.96 * drugSd[i]),
                B + Math.exp(drugLnMid[i] + 1.96 * drugSd[i]),
                EKF_CI_MAX_E2
            );
            [ci68Low[i], ci68High[i]] = clampCI(
                B + Math.exp(drugLnMid[i] - drugSd[i]),
                B + Math.exp(drugLnMid[i] + drugSd[i]),
                EKF_CI_MAX_E2
            );
        }
    } else {
        // Testosterone model on: the endogenous part is uncertain (T posterior,
        // ρ prior, B). Combine with the drug part through ONE shared batch of
        // posterior draws (common random numbers across all time points), and
        // read the bands off the empirical quantiles.
        const endoS = new Array<number>(POSTERIOR_DRAWS);
        const total = new Float64Array(POSTERIOR_DRAWS);
        const q = (sorted: Float64Array, p: number) => {
            const x = p * (sorted.length - 1);
            const lo = Math.floor(x);
            const hi = Math.min(sorted.length - 1, lo + 1);
            return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
        };
        for (let i = 0; i < n; i++) {
            const t = sim.timeH[i];
            sampleEndogenousE2(labBaseline[i], t, endo, endoS);
            let endoSum = 0;
            for (let s = 0; s < POSTERIOR_DRAWS; s++) {
                endoSum += endoS[s];
                total[s] = Math.exp(drugLnMid[i] + drugSd[i] * SHARED_DRAWS.drug[s]) + endoS[s];
            }
            total.sort();
            endogenousMean[i] = endoSum / POSTERIOR_DRAWS;
            e2Adjusted[i] = Math.min(drugCenter[i] + endogenousMean[i], EKF_CI_MAX_E2);
            [ci95Low[i], ci95High[i]] = clampCI(q(total, 0.025), q(total, 0.975), EKF_CI_MAX_E2);
            [ci68Low[i], ci68High[i]] = clampCI(q(total, 0.16), q(total, 0.84), EKF_CI_MAX_E2);
        }
    }

    // Per-compound anti-androgen adjusted curve + population PK CI band.
    // CPA inherits the learned E2 adherence amplitude (when enabled); other
    // anti-androgens (bicalutamide) are population-only with no learning.
    const antiandrogen: Partial<Record<Ester, { adjusted: number[]; ci95Low: number[]; ci95High: number[] }>> = {};
    for (const ester of ANTIANDROGEN_ESTERS) {
        const series = sim.byCompound?.[ester];
        if (!series) continue;
        const spec = ANTIANDROGENS[ester]!;
        const useAdherence = spec.adherenceFromE2 && applyE2LearningToCPA;

        const adjusted = new Array<number>(n).fill(0);
        const ci95Low = new Array<number>(n).fill(0);
        const ci95High = new Array<number>(n).fill(0);
        for (let i = 0; i < n; i++) {
            // CPA's adherence amplitude is learned from E2. In causal mode it is
            // taken from this point's snapshot so the CPA curve, like E2, never
            // has its past rewritten by later labs. Retrospective resolves to the
            // final state for every point (the legacy constant-scale behaviour).
            const st = useAdherence ? resolveState(sim.timeH[i]) : state;
            const scale = useAdherence ? Math.exp(st.thetaMean[0]) : 1;
            const adhVar = useAdherence ? Math.max(0, st.thetaCov[0][0]) : 0;
            const std = Math.sqrt(Math.max(0, adhVar + spec.popLogVar));

            const pred = Math.max(0, series.values[i] * scale);
            const yhat = Math.log(Math.max(pred, EKF_EPS_CPA));
            const [lo, hi] = clampCI(
                Math.exp(yhat - 1.96 * std),
                Math.exp(yhat + 1.96 * std),
                spec.ciMaxNative
            );
            adjusted[i] = Math.min(pred, spec.ciMaxNative);
            ci95Low[i] = lo;
            ci95High[i] = hi;
        }
        antiandrogen[ester] = { adjusted, ci95Low, ci95High };
    }

    // CPA → E2 clearance inhibition (CPA-specific; bicalutamide excluded).
    const cpaAdjusted = antiandrogen[Ester.CPA]?.adjusted;
    if (applyCPAInhibitionToE2 && cpaAdjusted) {
        for (let i = 0; i < n; i++) {
            const inhibition = computeCPAE2InhibitionFactor(cpaAdjusted[i]);
            const scale = 1 / (1 - inhibition);
            e2Adjusted[i] = Math.min(e2Adjusted[i] * scale, EKF_CI_MAX_E2);

            const s95Lo = ci95Low[i] * scale;
            const s95Hi = Math.min(ci95High[i] * scale, EKF_CI_MAX_E2);
            const s68Lo = ci68Low[i] * scale;
            const s68Hi = Math.min(ci68High[i] * scale, EKF_CI_MAX_E2);
            ci95Low[i] = Math.min(s95Lo, s95Hi);
            ci95High[i] = s95Hi;
            ci68Low[i] = Math.min(s68Lo, s68Hi);
            ci68High[i] = s68Hi;
        }
    }

    return {
        timeH: sim.timeH,
        e2Adjusted,
        ci95Low,
        ci95High,
        ci68Low,
        ci68High,
        e2DrugPersonal: drugCenter,
        endogenousMean,
        updateTimesH: calibrationMode === 'causal'
            ? [...new Set([...labResults.map(l => l.timeH), ...(sim.testosterone?.updateTimesH ?? [])])].sort((a, b) => a - b)
            : [],
        antiandrogen,
    };
}

/**
 * Coupled E2/T estimation (block-coordinate / alternating conditional MAP).
 *
 * The testosterone model is driven by the PERSONALISED drug E2 — the same
 * individual parameters that produce the E2 prediction — and the E2
 * calibration subtracts the endogenous E2 implied by that T posterior. The two
 * blocks are alternated until the T curve stops moving (≤ `maxIterations`):
 *   1. E2 calibration given T (all E2 labs, endogenous part from T),
 *   2. T calibration given the personalised E2 (all T labs; ηT only when
 *      enough post-treatment T labs exist),
 * so both lab types constrain the shared state. E2 labs inform the E2
 * exposure; T labs inform T sensitivity/residual and, through the endogenous
 * part, the E2 baseline subtraction. T labs deliberately do NOT re-estimate the
 * E2 exposure scale: with ηT free the two are not separately identifiable from
 * sparse T data. Every step honours the same data cutoff (`calibrationMode`).
 */
export function computeCoupledSimulationWithCI(
    sim: SimulationResult,
    events: DoseEvent[],
    state: PersonalModelState,
    applyE2LearningToCPA: boolean,
    labResults: LabResult[],
    calibrationModel: CalibrationModel,
    applyCPAInhibitionToE2: boolean,
    calibrationMode: CalibrationMode,
    testosterone?: TestosteroneModelOptions | null,
    maxIterations = 3,
    tolerance = COUPLING_TOLERANCE
): ReturnType<typeof computeSimulationWithCI> & {
    testosterone?: TestosteroneSeries;
    model: PersonalModelState;
    couplingIterations: number;
    /**
     * max |Δ log T| between the returned T and T recomputed from the returned
     * personalised E2 — 0 when not coupled. Below `tolerance` ⇔ the pair is a
     * fixed point of the coupled model.
     */
    couplingResidual: number;
} {
    if (!testosterone || !sim.testosterone || state.postDoseObservationCount === 0 || sim.timeH.length === 0) {
        const single = computeSimulationWithCI(sim, events, state, applyE2LearningToCPA, labResults,
            calibrationModel, applyCPAInhibitionToE2, calibrationMode);
        return { ...single, testosterone: sim.testosterone, model: state, couplingIterations: 0, couplingResidual: 0 };
    }
    const firstDose = [...events].filter(e => e.route !== Route.patchRemove).sort((a, b) => a.timeH - b.timeH)[0];
    const tOpts: TestosteroneModelOptions = {
        ...testosterone,
        mode: calibrationMode,
        firstDoseH: testosterone.firstDoseH ?? firstDose?.timeH,
    };
    const computeT = (e2: number[]) => computeTestosteroneSeries(sim.timeH, e2, sim.byCompound, tOpts);
    const maxLogDiff = (a: TestosteroneSeries, b: TestosteroneSeries) => {
        let d = 0;
        for (let i = 0; i < a.values.length; i++) {
            d = Math.max(d, Math.abs(Math.log(Math.max(a.values[i], 1e-9) / Math.max(b.values[i], 1e-9))));
        }
        return d;
    };
    const ciOf = (s: SimulationResult, m: PersonalModelState, fast?: { drugOnly: true; strideH: number }) =>
        computeSimulationWithCI(s, events, m, applyE2LearningToCPA, labResults,
            calibrationModel, applyCPAInhibitionToE2, calibrationMode, fast);
    const adopt = (T: TestosteroneSeries) => {
        current = { ...sim, testosterone: T };
        model = replayPersonalModel(events, labResults, makeEndogenousE2Context(current));
        iterations++;
    };

    let current: SimulationResult = sim;
    let model = state;
    let iterations = 0;

    // Phase 1 — cheap fixed-point iterations on the strided personalised E2
    // (identical centre formula to the full pass, only fewer grid points).
    const fast = { drugOnly: true as const, strideH: 2 };
    for (let k = 0; k < maxIterations; k++) {
        const T = computeT(ciOf(current, model, fast).e2DrugPersonal);
        const delta = maxLogDiff(T, current.testosterone!);
        adopt(T);
        if (delta < tolerance) break;
    }

    // Phase 2 — full resolution until the RETURNED pair is self-consistent:
    // T recomputed from the returned E2 must match the returned T.
    let ci = ciOf(current, model);
    let residual = maxLogDiff(computeT(ci.e2DrugPersonal), current.testosterone!);
    for (let k = 0; k < maxIterations && residual >= tolerance; k++) {
        adopt(computeT(ci.e2DrugPersonal));
        ci = ciOf(current, model);
        residual = maxLogDiff(computeT(ci.e2DrugPersonal), current.testosterone!);
    }
    return { ...ci, testosterone: current.testosterone, model, couplingIterations: iterations, couplingResidual: residual };
}

/** Convergence / self-consistency tolerance of the coupled E2/T estimation (max |Δ log T|). */
export const COUPLING_TOLERANCE = 0.005;
