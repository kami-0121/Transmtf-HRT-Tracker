import { Route, Ester, ExtraKey, type DoseEvent, type DoseEventExtras, type SimulationResult, type ConcUnit, type TestosteroneSeries } from './types';

/**
 * Route-specific metadata for transdermal gel absorption.
 *
 * These definitions live in the PK module because they directly affect
 * bioavailability calculations and are not useful outside the simulation layer.
 */
export enum GelSite {
    arm = "arm",
    thigh = "thigh",
    scrotal = "scrotal",
    abdomen = "abdomen"
}

// `abdomen` is appended AFTER `scrotal` so legacy events (gelSite index 0/1/2 =
// arm/thigh/scrotal) keep resolving to the same site; the UI orders sites
// separately for display.
export const GEL_SITE_ORDER = ["arm", "thigh", "scrotal", "abdomen"] as const;

/**
 * Relative transdermal penetration factor per application site, applied as a
 * multiplier on a product's base penetration rate `kPenBase`.
 *
 * Genital (scrotal) skin is markedly more permeable to steroids; the 8× factor
 * is a research-mode prior extrapolated from scrotal testosterone studies, not
 * a value validated for estradiol gel, and is surfaced as such in the UI.
 */
export const GEL_SITE_FACTORS: Record<GelSite, number> = {
    [GelSite.arm]: 1.0,
    [GelSite.thigh]: 1.0,
    [GelSite.abdomen]: 1.1,
    [GelSite.scrotal]: 8.0,
};

/**
 * A transdermal estradiol gel product. The registry below drives both the PK
 * engine and the dose-entry UI, so adding a gel only means registering one
 * entry — and end users can save custom products that follow the same shape.
 *
 * Kinetics follow a 3-compartment cascade (surface → skin reservoir → systemic
 * central, see {@link gel3CompCentralAmount}):
 *   - systemic absorbed fraction ≈ kPenBase / (kPenBase + kLoss) at the
 *     reference (non-genital) site and reference dose density
 *   - kRel sets the slow reservoir release that dominates the terminal phase
 * All numbers are population PRIORS to be calibrated against product labels.
 */
export interface GelProductSpec {
    id: number;                 // stable id (presets 1..N; custom products ≥ 1000)
    nameKey: string;            // i18n key for the display name (presets)
    name?: string;              // literal display name for user-created products
    concentrationMGmL: number;  // estradiol strength (mg/g ≈ mg/mL)
    defaultAreaCM2: number;     // typical single-dose application area
    refDoseMG: number;          // reference E2 dose used to anchor dose-density
    kPenBase: number;           // base penetration rate (h^-1) at reference site/density
    kLoss: number;              // surface loss rate (h^-1): evaporation/transfer/wash
    kRel: number;               // skin-reservoir → central release (h^-1)
    color?: string;
}

// Priors. The SURFACE clears fast (kPen + kLoss ≈ 1.4/h, t½ ≈ 0.5 h: solvent
// dries and drug either partitions into skin or is lost), so its split — not its
// timescale — sets the absorbed fraction F_ref = kPen/(kPen+kLoss). The slow
// terminal phase comes from the skin RESERVOIR releasing at kRel ≈ 0.022
// (t½ ≈ 31 h). Systemic ke = CorePK.kClear (0.41 h^-1). This reproduces tmax ≈ 8 h
// (EstroGel/Divigel range) and a 1 h-wash exposure retention ≈ 0.75 (labels: −22%
// EstroGel / −30% Divigel). kPenBase = F_ref·λ_s; kLoss = (1−F_ref)·λ_s, λ_s = 1.4.
export const GEL_PRODUCTS: GelProductSpec[] = [
    { id: 1, nameKey: 'gel.product.oestrogel', concentrationMGmL: 0.6, defaultAreaCM2: 750, refDoseMG: 1.5, kPenBase: 0.140, kLoss: 1.260, kRel: 0.022, color: '#ec4899' },
    { id: 2, nameKey: 'gel.product.estreva',   concentrationMGmL: 1.0, defaultAreaCM2: 400, refDoseMG: 1.5, kPenBase: 0.154, kLoss: 1.246, kRel: 0.022, color: '#f43f5e' },
    { id: 3, nameKey: 'gel.product.estrogel',  concentrationMGmL: 0.6, defaultAreaCM2: 750, refDoseMG: 1.5, kPenBase: 0.140, kLoss: 1.260, kRel: 0.022, color: '#d946ef' },
    { id: 4, nameKey: 'gel.product.divigel',   concentrationMGmL: 1.0, defaultAreaCM2: 200, refDoseMG: 1.0, kPenBase: 0.168, kLoss: 1.232, kRel: 0.024, color: '#a855f7' },
    { id: 5, nameKey: 'gel.product.diy',       concentrationMGmL: 1.0, defaultAreaCM2: 400, refDoseMG: 2.0, kPenBase: 0.112, kLoss: 1.288, kRel: 0.022, color: '#8b5cf6' },
];

export const GEL_DEFAULT_PRODUCT_ID = 1;

/** Look up a PRESET gel product by id, defaulting to Oestrogel. */
export function getGelProduct(id: number | undefined): GelProductSpec {
    return GEL_PRODUCTS.find(p => p.id === id) ?? GEL_PRODUCTS[0];
}

// User-defined custom gel products. Gel dose events only store the product id;
// the kinetics are resolved from this registry at SIMULATION time so editing a
// custom product (in Settings) propagates to every record that uses it. The app
// keeps this mirror in sync via `setCustomGelProducts` whenever the cloud-synced
// `gelProducts` list changes. Presets always resolve from code, so a viewer
// without the custom list still renders preset gels correctly.
let CUSTOM_GEL_PRODUCTS: GelProductSpec[] = [];

/** Custom (user-created) gel product ids start here so they never collide with presets. */
export const GEL_CUSTOM_ID_BASE = 1000;

/**
 * Validate ONE untrusted custom gel product (from import / share / cloud / stored
 * registry) into a usable spec, or `null` if unusable.
 *
 * This is the single canonical sanitizer reused by the engine registry and by
 * `doseForm.ts`, so the two entry points can never diverge. Policy:
 *   - id must be finite AND ≥ GEL_CUSTOM_ID_BASE (never shadow a preset)
 *   - ONLY the three rate constants (kPenBase/kLoss/kRel) are non-defaultable: a
 *     missing/NaN rate DROPS the entry rather than fabricating a plausible-but-
 *     wrong curve. Metadata (concentration/area/refDose) is given a sane default
 *     so a valid-kinetics product that merely omits a display field survives.
 *   - finite-but-out-of-range values are clamped; kRel is held inside the
 *     UI-editable half-life window [1, 240] h so imported products stay editable.
 */
export function sanitizeGelProduct(v: unknown): GelProductSpec | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const fin = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

    const id = fin(o.id);
    if (id === null || id < GEL_CUSTOM_ID_BASE) return null;

    const kPenBase = fin(o.kPenBase), kLoss = fin(o.kLoss), kRel = fin(o.kRel);
    if (kPenBase === null || kLoss === null || kRel === null) return null;

    const conc = fin(o.concentrationMGmL);
    const area = fin(o.defaultAreaCM2);
    const refDose = fin(o.refDoseMG);
    const areaC = area !== null ? clamp(area, 1, 5000) : 400;
    const KREL_MIN = Math.log(2) / 240, KREL_MAX = Math.log(2) / 1; // t½ ∈ [1, 240] h
    return {
        id: Math.round(id),
        nameKey: '',
        name: typeof o.name === 'string' ? o.name : undefined,
        concentrationMGmL: conc !== null ? clamp(conc, 0.01, 100) : 1.0,
        defaultAreaCM2: areaC,
        refDoseMG: refDose !== null ? clamp(refDose, 0.01, 100) : areaC * 0.002,
        kPenBase: clamp(kPenBase, 1e-4, 5),
        kLoss: clamp(kLoss, 0, 10),
        kRel: clamp(kRel, KREL_MIN, KREL_MAX),
        color: typeof o.color === 'string' ? o.color : undefined,
    };
}

/** Validate an array of untrusted custom gel products (drops bad entries + dup ids). */
export function sanitizeGelProducts(list: unknown): GelProductSpec[] {
    if (!Array.isArray(list)) return [];
    const out: GelProductSpec[] = [];
    for (const item of list) {
        const p = sanitizeGelProduct(item);
        if (p && !out.some(q => q.id === p.id)) out.push(p);
    }
    return out;
}

/**
 * Replace the in-engine custom gel registry (called by AppDataContext / ShareView).
 * Every entry is validated so untrusted input cannot inject non-physical kinetics.
 */
export function setCustomGelProducts(list: GelProductSpec[]): void {
    CUSTOM_GEL_PRODUCTS = sanitizeGelProducts(list);
}

/** True when the id maps to a real preset or known custom product (not a fallback). */
export function gelProductExists(id: number | undefined): boolean {
    return GEL_PRODUCTS.some(p => p.id === id) || CUSTOM_GEL_PRODUCTS.some(p => p.id === id);
}

/** Resolve a gel product id against presets first, then custom products. */
export function getGelProductById(id: number | undefined): GelProductSpec {
    return GEL_PRODUCTS.find(p => p.id === id)
        ?? CUSTOM_GEL_PRODUCTS.find(p => p.id === id)
        ?? GEL_PRODUCTS[0];
}

// Soft-saturation half-point for areal dose density σ = dose/area (mg·cm⁻²),
// defined at the reference gel strength GEL_CONC_REF. Spreading the same dose over
// a larger area lowers σ and raises fractional absorption; concentrating it raises
// σ and lowers absorption (Maturitas: the E2 MASS per unit skin area is a primary
// determinant of uptake). The factor is normalized to 1.0 at each product's
// reference density so the product's F_ref is preserved.
const GEL_SIGMA_SAT = 0.008;
// Reference gel strength (mg·mL⁻¹) at which GEL_SIGMA_SAT applies. The same E2 mass
// carried in a MORE concentrated gel sits in a thinner, more drug-dense film that
// saturates skin partitioning at a higher areal load, so the half-point scales with
// strength: σ_sat(c) = GEL_SIGMA_SAT · c / GEL_CONC_REF. This makes
// `concentrationMGmL` an explicit kinetic variable — it formerly only labelled the
// product and never entered the dynamics. It is a structural population PRIOR
// pending IVPT calibration, NOT a fitted value, and only bites OFF the reference
// density: at the product's reference dose/area the factor is exactly 1.0, so
// default-dose predictions are unchanged regardless of concentration.
const GEL_CONC_REF = 1.0;

export interface GelKinetics { kPen: number; kLoss: number; kRel: number; }

/**
 * Resolve a product + site + dose + area into the EFFECTIVE cascade rate
 * constants. Called at simulation time (not persisted on the event) so editing a
 * custom product re-resolves the kinetics for every record that references it.
 */
export function resolveGelKinetics(
    product: GelProductSpec,
    site: GelSite,
    doseMG: number,
    areaCM2: number
): GelKinetics {
    const rSite = GEL_SITE_FACTORS[site] ?? 1.0;
    const area = areaCM2 > 0 ? areaCM2 : product.defaultAreaCM2;
    const sigma = doseMG > 0 ? doseMG / area : 0;
    const sigmaRef = product.defaultAreaCM2 > 0 ? product.refDoseMG / product.defaultAreaCM2 : 0;
    // Concentration-aware half-saturation: a stronger gel saturates skin uptake at
    // a higher areal load (thinner, drug-denser film). Falls back to the reference
    // strength for a missing/non-positive concentration so the factor is well-defined.
    const concRel = product.concentrationMGmL > 0 ? product.concentrationMGmL / GEL_CONC_REF : 1;
    const sigmaSat = GEL_SIGMA_SAT * concRel;
    let densityFactor = sigma > 0
        ? (1 + sigmaRef / sigmaSat) / (1 + sigma / sigmaSat)
        : 1;
    densityFactor = Math.min(2.0, Math.max(0.5, densityFactor));
    // Genital (scrotal) skin: the keratinized-skin dose-density correction is NOT
    // applied here. The scrotal application area cannot be reliably measured, and the
    // genital permeability prior (the 8× site factor, itself only a low-evidence
    // testosterone extrapolation) is not a dose-density relationship. Applying the
    // correction would only compound a spurious area dependence on top of rSite (e.g.
    // a default 750 cm² would push the factor toward its 2× clamp). Neutralizing it
    // makes the scrotal estimate area-invariant — the honest behaviour, since the
    // area is unknowable. (This does NOT assert near-complete absorption: the absorbed
    // fraction is still kPen/(kPen+kLoss), e.g. ≈0.47 for Oestrogel.)
    if (site === GelSite.scrotal) densityFactor = 1.0;
    return { kPen: product.kPenBase * rSite * densityFactor, kLoss: product.kLoss, kRel: product.kRel };
}

// --- Application-area coverage templates --------------------------------------
//
// Raw cm² is hostile to end users — nobody measures their application patch. Labels
// themselves use recognizable language ("about two palms", "wrist to shoulder"), so
// the UI lets the user pick an EXTENT and the resolved area (cm²) is what the engine
// stores in `areaCM2`; the PK layer is unchanged. Values are coarse population
// PRIORS: `palm*` use the ~1% TBSA palm method (≈175 cm²/palm, which self-scales
// with body size); limb templates are anchored to the product labels (Divigel thigh
// ≈200 cm², EstroGel/Oestrogel arm wrist→shoulder ≈750 cm²). Body type shifts these,
// so a `manual` cm² escape hatch is always offered.
export type GelCoverageKind = 'product' | 'fixed' | 'manual';
export interface GelCoverageTemplate {
    key: string;            // i18n suffix: gel.coverage.<key>
    kind: GelCoverageKind;  // 'product' = product default area; 'fixed' = areaCM2; 'manual' = user cm²
    areaCM2?: number;       // only for kind === 'fixed'
}

/** One "palm" (palm + fingers) ≈ 1% of total body surface area for a ~1.7 m² adult. */
export const GEL_PALM_AREA_CM2 = 175;

export const GEL_COVERAGE_TEMPLATES: GelCoverageTemplate[] = [
    { key: 'product', kind: 'product' },
    { key: 'palm1',   kind: 'fixed', areaCM2: 1 * GEL_PALM_AREA_CM2 },
    { key: 'palm2',   kind: 'fixed', areaCM2: 2 * GEL_PALM_AREA_CM2 },
    { key: 'palm3',   kind: 'fixed', areaCM2: 3 * GEL_PALM_AREA_CM2 },
    { key: 'thigh',   kind: 'fixed', areaCM2: 200 },   // Divigel single upper-thigh anchor
    { key: 'arm',     kind: 'fixed', areaCM2: 750 },   // EstroGel/Oestrogel single arm wrist→shoulder
    { key: 'arms2',   kind: 'fixed', areaCM2: 1500 },  // both arms
    { key: 'manual',  kind: 'manual' },
];

/** Default coverage for a NEW gel record: follow the product's labelled area. */
export const GEL_COVERAGE_DEFAULT_IDX = 0;
/** Index of the "enter cm² manually" template (also the legacy/back-compat fallback). */
export const GEL_COVERAGE_MANUAL_IDX = GEL_COVERAGE_TEMPLATES.findIndex(t => t.kind === 'manual');

/**
 * Resolve a coverage-template choice into an application area (cm²). `manualAreaCM2`
 * is consulted only for the `manual` template (or an out-of-range index); every
 * other case derives the area from the template / product so the user never has to
 * type a number. Always returns a positive cm² (falls back to the product default).
 */
export function resolveGelCoverageArea(
    coverageIdx: number | undefined,
    product: GelProductSpec,
    manualAreaCM2: number
): number {
    const tpl = (typeof coverageIdx === 'number' && coverageIdx >= 0 && coverageIdx < GEL_COVERAGE_TEMPLATES.length)
        ? GEL_COVERAGE_TEMPLATES[coverageIdx]
        : undefined;
    const manualOK = Number.isFinite(manualAreaCM2) && manualAreaCM2 > 0;
    if (!tpl || tpl.kind === 'manual') return manualOK ? manualAreaCM2 : product.defaultAreaCM2;
    if (tpl.kind === 'product') return product.defaultAreaCM2;
    return (typeof tpl.areaCM2 === 'number' && tpl.areaCM2 > 0) ? tpl.areaCM2 : product.defaultAreaCM2;
}

// --- Co-applied topical products ----------------------------------------------
//
// A topical product layered over the gel measurably shifts transdermal exposure.
// EstroGel label data (applied daily 1 h after the gel): a SUNSCREEN lowers AUC0–24
// ≈16%; a MOISTURIZER raises it ≈38% (and Cmax ≈73%). Modelled as a multiplicative
// factor on the systemically absorbed amount — an AUC-anchored EXPOSURE prior. We
// scale total exposure, not the peak shape, so the extra Cmax skew a moisturizer can
// add is intentionally NOT separately modelled (it would need a kPen reshape and has
// weaker evidence). These are product-specific label priors used as a generalization.
export const GEL_COAPPLICATION_ORDER = ['none', 'sunscreen', 'moisturizer'] as const;
export type GelCoApplication = typeof GEL_COAPPLICATION_ORDER[number];
export const GEL_COAPPLICATION_FACTORS: Record<GelCoApplication, number> = {
    none: 1.0,
    sunscreen: 0.84,    // −16% AUC0–24
    moisturizer: 1.38,  // +38% AUC0–24
};

/**
 * Multiplicative exposure factor for the co-applied product recorded on an event.
 * Only EXACT known indices map to a factor; anything else (absent, non-finite,
 * negative, or an unknown/future index) is NEUTRAL (1.0). This is deliberate: a
 * corrupt value or a future client's new option must never be silently reinterpreted
 * as e.g. moisturizer (+38%).
 */
export function gelCoApplicationFactor(extras: DoseEventExtras | undefined): number {
    const raw = extras?.[ExtraKey.gelCoApplied];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1.0;
    const idx = Math.round(raw);
    if (idx < 0 || idx >= GEL_COAPPLICATION_ORDER.length) return 1.0;
    const f = GEL_COAPPLICATION_FACTORS[GEL_COAPPLICATION_ORDER[idx]];
    return (Number.isFinite(f) && f > 0) ? f : 1.0;
}

// --- 3-compartment cascade closed form (surface → reservoir → central) -------

// Nudge near-equal eigenvalues apart so the symmetric partial-fraction form
// never divides by zero. The perturbation is ~1e-6 h^-1, far below any
// physically meaningful resolution, so the curve is unaffected.
function separateEigs(a: number, b: number, c: number): [number, number, number] {
    const eps = 1e-6;
    let x = a, y = b, z = c;
    if (Math.abs(x - y) < eps) y += eps;
    if (Math.abs(x - z) < eps) z += eps;
    if (Math.abs(y - z) < eps) z += eps;
    return [x, y, z];
}

// Central amount for a surface depot of `doseMG` decaying at l1, feeding a
// reservoir (release l2) that feeds the central compartment (clearance l3).
function gelCentral3(doseMG: number, kPen: number, kRel: number, l1: number, l2: number, l3: number, t: number): number {
    const [a, b, c] = separateEigs(l1, l2, l3);
    const e1 = Math.exp(-a * t) / ((b - a) * (c - a));
    const e2 = Math.exp(-b * t) / ((a - b) * (c - b));
    const e3 = Math.exp(-c * t) / ((a - c) * (b - c));
    return doseMG * kPen * kRel * (e1 + e2 + e3);
}

// Reservoir (skin) amount for the same surface depot.
function gelSkin2(doseMG: number, kPen: number, l1: number, l2: number, t: number): number {
    const a = l1, b = Math.abs(l1 - l2) < 1e-6 ? l2 + 1e-6 : l2;
    return doseMG * kPen * (Math.exp(-a * t) - Math.exp(-b * t)) / (b - a);
}

/**
 * Layered transdermal-gel central-compartment amount (mg) at `tau` hours after a
 * single application of `doseMG`.
 *
 * Surface → skin reservoir → systemic central linear cascade:
 *   M_s'    = −(kPen + kLoss)·M_s
 *   M_skin' =   kPen·M_s − kRel·M_skin
 *   M_c'    =   kRel·M_skin − ke·M_c       ← returned
 *
 * `washAfterH`: at that time the remaining surface film is removed (washed /
 * rubbed off), so only the surface present in [0, washAfterH] contributes —
 * implemented as a two-segment solve.
 */
export function gel3CompCentralAmount(
    doseMG: number,
    tau: number,
    kPen: number,
    kLoss: number,
    kRel: number,
    ke: number,
    washAfterH?: number
): number {
    // Reject any non-physical / non-finite rate so a corrupt product (e.g. from
    // a hand-edited share payload) can never inject NaN/Inf into the curve.
    if (!Number.isFinite(doseMG) || !Number.isFinite(tau) ||
        !Number.isFinite(kPen) || !Number.isFinite(kLoss) ||
        !Number.isFinite(kRel) || !Number.isFinite(ke)) return 0;
    if (tau <= 0 || doseMG <= 0 || kPen <= 0 || kRel <= 0 || ke <= 0 ||
        kLoss < 0 || (kPen + kLoss) <= 0) return 0;
    const l1 = kPen + kLoss; // surface
    const l2 = kRel;         // reservoir release
    const l3 = ke;           // systemic clearance
    const wash = (typeof washAfterH === 'number' && Number.isFinite(washAfterH) && washAfterH > 0)
        ? washAfterH : Infinity;

    if (tau <= wash) {
        return Math.max(0, gelCentral3(doseMG, kPen, kRel, l1, l2, l3, tau));
    }
    // Phase 2: surface removed at `wash`; carry reservoir + central forward.
    const mSkinWash = gelSkin2(doseMG, kPen, l1, l2, wash);
    const mcWash = gelCentral3(doseMG, kPen, kRel, l1, l2, l3, wash);
    const s = tau - wash;
    const b = l2, c = Math.abs(l2 - l3) < 1e-6 ? l3 + 1e-6 : l3;
    const mc = mcWash * Math.exp(-c * s)
        + kRel * mSkinWash * (Math.exp(-b * s) - Math.exp(-c * s)) / (c - b);
    return Math.max(0, mc);
}

/**
 * Central-compartment amount (mg) for one gel event at `tau` hours, with the
 * systemic clearance `ke` supplied by the caller (the EKF layer scales it).
 *
 * The event stores only the product id + per-application site/area/wash; the
 * product's intrinsic kinetics are resolved from the registry here, so editing a
 * custom product updates every record that references it.
 */
export function gelEventCentralAmount(event: DoseEvent, tau: number, ke: number): number {
    if (tau <= 0 || event.doseMG <= 0) return 0;
    const ex = event.extras ?? {};
    const product = getGelProductById(ex[ExtraKey.gelProductId]);
    const siteIdx = Math.min(GEL_SITE_ORDER.length - 1, Math.max(0, Math.round(ex[ExtraKey.gelSite] ?? 0)));
    const site = (GEL_SITE_ORDER[siteIdx] ?? GelSite.arm) as GelSite;
    const areaRaw = ex[ExtraKey.areaCM2];
    const area = (typeof areaRaw === 'number' && areaRaw > 0) ? areaRaw : product.defaultAreaCM2;
    const k = resolveGelKinetics(product, site, event.doseMG, area);
    const amount = gel3CompCentralAmount(event.doseMG, tau, k.kPen, k.kLoss, k.kRel, ke, ex[ExtraKey.gelWashAfterH]);
    // A co-applied sunscreen/moisturizer scales total absorbed exposure (linear
    // cascade ⇒ multiplying the central amount == scaling the effective dose).
    return amount * gelCoApplicationFactor(ex);
}

/**
 * Shared PK constants used by the population model.
 *
 * These are exported because the personal-model code in `logic.ts` still builds
 * on top of the same physiological assumptions and needs direct access to them.
 */
export const CorePK = {
    vdPerKG: 2.0,
    /** @deprecated Use CPA_2COMP_PK.V1_per_kg (central Vc) instead of this apparent Vd */
    vdPerKG_CPA: 14.0,
    kClear: 0.41,
    kClearInjection: 0.041,
    depotK1Corr: 1.0
};

/**
 * CPA 2-compartment oral PK constants calibrated to high-dose oral tablet SmPC
 * data (e.g. Androcur / Cyprostat 50 mg tablets), which better matches the
 * tablet regimens used in this app than the much earlier-peaking 2 mg
 * Diane-35 formulation.
 *
 * Targets used for the calibration:
 * - absolute bioavailability F ≈ 88%
 * - single-dose Cmax ≈ 285 ng/mL at Tmax ≈ 3 h after 100 mg oral
 * - terminal half-life t1/2 ≈ 43.9 h
 * - total clearance ≈ 3.5 mL/min/kg
 *
 * Exported so higher-level calibration code can reuse the same population
 * variance and central-compartment assumptions without duplicating numbers.
 */
export const CPA_2COMP_PK = {
    F: 0.88,
    ka: 0.60,
    alpha: 0.20,
    beta: 0.01579,
    k21: 0.04,
    V1_per_kg: 2.666,
    popLogVar: 0.09,
};

/**
 * Bicalutamide apparent one-compartment oral PK constants ("chronic calibration"
 * default set). Bicalutamide's clinically relevant activity comes from the
 * (R)-enantiomer; we model that directly with apparent first-order absorption /
 * elimination rather than splitting enantiomers or first-pass.
 *
 * Targets used for the calibration (FDA Casodex label, Table 3; SmPC):
 * - single-dose Tmax ≈ 31 h, Cmax ≈ 0.77 µg/mL
 * - terminal half-life ≈ 5.8 d
 * - 50 mg once-daily steady state ≈ 9 µg/mL
 *
 * `vOverF` is an ABSOLUTE apparent volume (L), not per-kg, so the concentration
 * conversion for bicalutamide does not scale with body weight.
 */
export const BICA_PK = {
    ka: 0.10,                       // h^-1  (Tmax ≈ 31 h)
    ke: Math.log(2) / (5.8 * 24),   // h^-1  (t½ ≈ 5.8 d)
    vOverF: 50.2,                   // L (apparent V/F)
    popLogVar: 0.10,                // ≈ 30% CV population PK uncertainty
};

/**
 * Spironolactone (SPL / 螺內酯) apparent one-compartment oral PK constants.
 *
 * Spironolactone itself is cleared within hours (t½ ≈ 1.4 h); its sustained
 * anti-androgen / anti-mineralocorticoid activity comes from the active
 * metabolites canrenone and 7α-thiomethylspironolactone. The tracked analyte is
 * therefore CANRENONE, modeled with apparent first-order formation (`ka`, which
 * lumps absorption + metabolic conversion) and elimination. Dose is entered as
 * spironolactone mg; `vOverF` is the apparent canrenone volume per mg of parent
 * dose, so the conversion fraction is folded into it.
 *
 * Targets used for the calibration (Aldactone label, 100 mg/day × 15 days, fed):
 * - canrenone Tmax ≈ 4.3 h (model: ≈ 4.0 h at steady state, ≈ 4.8 h single dose)
 * - canrenone Cmax ≈ 181 ng/mL at steady state
 * - canrenone t½ ≈ 16.5 h
 *
 * `vOverF` is an ABSOLUTE apparent volume (L), not per-kg.
 */
export const SPL_PK = {
    ka: 0.60,                       // h^-1  apparent canrenone formation
    ke: Math.log(2) / 16.5,         // h^-1  (canrenone t½ ≈ 16.5 h)
    vOverF: 737,                    // L     (apparent canrenone V/F per parent mg)
    popLogVar: 0.12,                // ≈ 35% CV population PK uncertainty
};

/**
 * Endogenous testosterone (HPG axis) model — "t-suppression-v1".
 *
 * Why it exists: in an untreated AMAB body most circulating E2 (≈ 20–30 pg/mL)
 * is made by aromatising testosterone. That background E2 is NOT constant once
 * HRT starts — exogenous estradiol and anti-androgens suppress LH and therefore
 * testosterone, so the aromatised E2 fades too. Treating the pre-treatment
 * baseline as a constant offset over-predicts E2 on suppressive regimens (and
 * the EKF then mis-attributes that bias to the PK parameters). This model makes
 * the endogenous E2 baseline time-varying: E2_endo(t) = B · T(t) / T0.
 *
 * Structure (indirect-response turnover with Emax drug effects):
 *   T_target(t) = T0 · (1 − I_E2) · (1 − I_CPA) · (1 − I_SPL) · (1 + S_BICA)
 *   dT/dt       = kout · (T_target − T)
 * where each I = Imax·C^n / (IC50^n + C^n) uses the population DRUG
 * concentration (exogenous E2 in pg/mL, anti-androgens in ng/mL), and
 * bicalutamide's AR blockade at the hypothalamus RAISES LH/T (stimulation S).
 *
 * Anchors (population priors; individual responses vary widely):
 * - E2 monotherapy: ≈ 100 pg/mL → T ≈ 350 ng/dL, ≈ 200 → ≈ 120, ≥ 300 → < 55
 * - CPA 10–12.5 mg/day alone suppresses T by roughly 70–80 %
 * - spironolactone lowers T only modestly (mostly an AR antagonist)
 * - bicalutamide monotherapy raises T (and aromatised E2) by ≈ 50 %
 * - T falls to a new steady state over a few days (response t½ ≈ 2 d)
 */
export const TESTOSTERONE_MODEL = {
    /** Default pre-treatment total testosterone (ng/dL) for display scaling. */
    baselineNgdL: 500,
    /** Pre-treatment endogenous E2 (pg/mL) used when no pre-dose lab exists. */
    defaultBaselineE2PGmL: 25,
    /** First-order response rate of T toward its target (h^-1, t½ ≈ 48 h). */
    kout: Math.log(2) / 48,
    e2: { Imax: 0.97, IC50: 130, n: 3 },
    cpa: { Imax: 0.90, IC50: 5, n: 1 },
    spl: { Imax: 0.40, IC50: 100, n: 1 },
    bica: { Smax: 0.60, EC50: 3000, n: 1 },
    /** Floor for the endogenous fraction (adrenal androgens never fully vanish). */
    minFraction: 0.02,
};

/** A measured total testosterone value (from a blood report), in ng/dL. */
export interface TestosteroneObservation {
    timeH: number;
    ngdL: number;
}

/**
 * Temporal semantics shared with the E2 calibration (`CalibrationMode`):
 * - `causal`: the estimate at time t uses only labs drawn at or before t
 *   (forward filter) — the honest "what could be predicted then" view, and the
 *   one to use for validating predictions.
 * - `retrospective`: every estimate uses all labs (smoother) — the best
 *   hindsight reconstruction; later labs DO reshape earlier estimates.
 */
export type TCalibrationMode = 'causal' | 'retrospective';

/** Options enabling the testosterone model in {@link runSimulation}. */
export interface TestosteroneModelOptions {
    /** Pre-treatment total testosterone in ng/dL (fallback when no pre-treatment T lab). */
    baselineNgdL?: number;
    /** Measured total testosterone (blood reports). */
    observations?: TestosteroneObservation[];
    /** Time of the first dose (h); observations before it count as pre-treatment. */
    firstDoseH?: number;
    /** Data cutoff semantics; must match the E2 calibration mode. Default retrospective. */
    mode?: TCalibrationMode;
}

/**
 * Calibration of the T curve to measured testosterone ("t-gp-v2").
 *
 * log T_measured(t_i) = log T0 + δ0 + log S(t_i; ηT) + a(t_i)·u(t_i) + ε_i
 *
 * - δ0: the individual's offset from the assumed T0 (population default or the
 *   user's setting), prior SD `t0SdLog*`. Constant in time, so labs drawn
 *   BEFORE treatment mostly inform δ0 — that is how pre-treatment labs set the
 *   personal T0. δ0 does not change T/T0.
 * - S(t; ηT): structural response T/T0 from the turnover model; ηT scales all
 *   suppression/stimulation potencies by exp(ηT). ηT is estimated (MAP under the
 *   GP marginal likelihood, prior SD `etaPriorSd`) only with at least
 *   `etaMinPostDoseLabs` post-treatment labs — with sparse data it stays 0.
 * - a(t)·u(t): individual deviation of the RESPONSE. u is an OU process (SD
 *   `priorSdLog`, correlation `lengthScaleH`); the amplitude
 *   a(t) = min(1, |ln S_pop(t)| / ln 2) is 0 without drug effect and 1 once T
 *   has moved by a factor of 2, so pre-treatment T/T0 stays exactly 1.
 * - ε: assay + diurnal noise, SD `noiseSdLog`.
 *
 * `causal` evaluates every time point with only the labs drawn at or before
 * it (exact GP on that prefix ≡ Kalman filter); `retrospective` uses all labs
 * (smoother). Posterior variances of both log T and of the response part are
 * returned and propagated into endogenous E2. All constants are PRIORS
 * awaiting validation — individual HPG responses (notably to bicalutamide)
 * vary widely.
 */
export const T_CALIBRATION = {
    priorSdLog: 0.8,
    lengthScaleH: 45 * 24,
    noiseSdLog: 0.2,
    t0SdLogPopulation: 0.35,
    t0SdLogSetting: 0.15,
    /** Bounds on the multiplicative correction exp(r). */
    minRatio: 0.05,
    maxRatio: 20,
    etaPriorSd: 0.5,
    etaMinPostDoseLabs: 2,
    etaBounds: [-2.5, 2.5] as [number, number],
};

/**
 * Endogenous (non-drug) E2 model: E2_endo(t) = B · (ρ · T(t)/T0 + (1 − ρ)).
 *
 * ρ is the share of the pre-treatment endogenous E2 assumed to track total T
 * (aromatisation of T and LH-driven testicular secretion); the remainder
 * (e.g. aromatised adrenal androstenedione) is held constant. Neither the
 * proportionality nor ρ is established for every individual, so ρ is a PRIOR
 * that is never fitted — its uncertainty (logit-normal) is propagated instead.
 * B comes from pre-treatment E2 labs when present (with a small lab SD),
 * otherwise from a wide population prior. With sparse data the model therefore
 * never estimates B, ρ and the T↔E2 conversion all at once.
 */
export const ENDOGENOUS_E2 = {
    coupledShareMedian: 0.75,
    coupledShareSdLogit: 1.0,
    baselineDefaultPGmL: 25,
    baselineDefaultSdLog: 0.4,
    baselineLabSdLog: 0.15,
};

const hillEffect = (c: number, emax: number, c50: number, n: number): number => {
    if (!(c > 0)) return 0;
    const cn = Math.pow(c, n);
    return emax * cn / (Math.pow(c50, n) + cn);
};

/**
 * Steady-state testosterone fraction T_target/T0 for the given instantaneous
 * drug exposure. `etaT` scales every potency by exp(etaT) (individual HPG
 * sensitivity). Exported for tests and for explaining the model in the UI.
 */
export function testosteroneTargetFraction(
    e2DrugPGmL: number,
    aaNgML: Partial<Record<Ester, number>> = {},
    etaT = 0
): number {
    const m = TESTOSTERONE_MODEL;
    const k = Math.exp(etaT);
    const iE2 = hillEffect(e2DrugPGmL, m.e2.Imax, m.e2.IC50 * k, m.e2.n);
    const iCPA = hillEffect(aaNgML[Ester.CPA] ?? 0, m.cpa.Imax, m.cpa.IC50 * k, m.cpa.n);
    const iSPL = hillEffect(aaNgML[Ester.SPL] ?? 0, m.spl.Imax, m.spl.IC50 * k, m.spl.n);
    const sBICA = hillEffect(aaNgML[Ester.BICA] ?? 0, m.bica.Smax, m.bica.EC50 * k, m.bica.n);
    const f = (1 - iE2) * (1 - iCPA) * (1 - iSPL) * (1 + sBICA);
    return Math.max(m.minFraction, f);
}

/** Hill term specialised for the integer exponents used (avoids Math.pow in the hot loop). */
const hillFast = (c: number, emax: number, c50: number, n: number): number => {
    if (!(c > 0)) return 0;
    const cn = n === 1 ? c : n === 3 ? c * c * c : Math.pow(c, n);
    const kn = n === 1 ? c50 : n === 3 ? c50 * c50 * c50 : Math.pow(c50, n);
    return emax * cn / (kn + cn);
};

/**
 * Integrate the T/T0 turnover ODE (exact step for piecewise-constant targets)
 * on the grid, or — with `strideH` — on a subsampled grid whose points are at
 * least `strideH` apart (used by the ηT optimiser; T has t½ ≈ 48 h). Returns
 * the evaluated times and values.
 */
function integrateTFraction(
    timeH: number[],
    e2PGmL: number[],
    byCompound: SimulationResult['byCompound'],
    etaT: number,
    strideH = 0
): { t: number[]; v: number[] } {
    const m = TESTOSTERONE_MODEL;
    const k = Math.exp(etaT);
    const cpa = byCompound[Ester.CPA]?.values;
    const spl = byCompound[Ester.SPL]?.values;
    const bica = byCompound[Ester.BICA]?.values;
    const e2c = m.e2.IC50 * k, cpac = m.cpa.IC50 * k, splc = m.spl.IC50 * k, bicac = m.bica.EC50 * k;
    const ts: number[] = [];
    const vs: number[] = [];
    let frac = 1;
    let lastT = -Infinity;
    const n = timeH.length;
    for (let i = 0; i < n; i++) {
        const t = timeH[i];
        if (strideH > 0 && i !== 0 && i !== n - 1 && t - lastT < strideH) continue;
        const f = (1 - hillFast(e2PGmL[i] ?? 0, m.e2.Imax, e2c, m.e2.n))
            * (1 - hillFast(cpa ? cpa[i] : 0, m.cpa.Imax, cpac, m.cpa.n))
            * (1 - hillFast(spl ? spl[i] : 0, m.spl.Imax, splc, m.spl.n))
            * (1 + hillFast(bica ? bica[i] : 0, m.bica.Smax, bicac, m.bica.n));
        const target = Math.max(m.minFraction, f);
        if (ts.length > 0) frac = target + (frac - target) * Math.exp(-m.kout * Math.max(0, t - lastT));
        ts.push(t);
        vs.push(frac);
        lastT = t;
    }
    return { t: ts, v: vs };
}

/** Cholesky factor of a small symmetric positive-definite matrix. */
function cholesky(A: number[][]): number[][] {
    const n = A.length;
    const L = A.map(row => row.map(() => 0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = A[i][j];
            for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
            L[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / L[j][j];
        }
    }
    return L;
}

/** Solve (L Lᵀ) x = b given the Cholesky factor L. */
function cholSolve(L: number[][], b: number[]): number[] {
    const n = b.length;
    const y = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
        let sum = b[i];
        for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
        y[i] = sum / L[i][i];
    }
    const x = new Array<number>(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        let sum = y[i];
        for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
        x[i] = sum / L[i][i];
    }
    return x;
}

/** Response-deviation amplitude a(t) from the population structural fraction. */
export const responseAmplitude = (structFrac: number): number =>
    Math.min(1, Math.abs(Math.log(Math.max(structFrac, 1e-9))) / Math.LN2);

export interface TGPResult {
    /** Posterior mean / variance of the response deviation a(t)·u(t) (affects T/T0). */
    rMean: number[];
    rVar: number[];
    /** Posterior mean / variance of δ0 + a(t)·u(t) (absolute log T vs. the structural curve). */
    totalMean: number[];
    totalVar: number[];
}

/** A GP conditioned on a fixed set of observations; evaluates at any (t, a(t)). */
interface TGPPosterior {
    at: (t: number, a: number) => { rMean: number; rVar: number; totalMean: number; totalVar: number };
}

/**
 * Condition the T-calibration GP (see T_CALIBRATION) on observations with log
 * residuals `y` and response amplitudes `obsAmp`. With no observations the
 * prior is returned.
 */
function conditionTGP(obsTimes: number[], y: number[], obsAmp: number[], t0SdLog: number, p = T_CALIBRATION): TGPPosterior {
    const s2 = p.priorSdLog * p.priorSdLog;
    const d2 = t0SdLog * t0SdLog;
    const e2 = p.noiseSdLog * p.noiseSdLog;
    const lo = Math.log(p.minRatio), hi = Math.log(p.maxRatio);
    const clamp = (v: number) => Math.min(hi, Math.max(lo, v));
    const k = obsTimes.length;
    const kr = (ta: number, aa: number, tb: number, ab: number) => aa * ab * s2 * Math.exp(-Math.abs(ta - tb) / p.lengthScaleH);
    if (k === 0) {
        return { at: (_t, a) => ({ rMean: 0, rVar: a * a * s2, totalMean: 0, totalVar: a * a * s2 + d2 }) };
    }
    const L = cholesky(Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) =>
        kr(obsTimes[i], obsAmp[i], obsTimes[j], obsAmp[j]) + d2 + (i === j ? e2 : 0))));
    const alpha = cholSolve(L, y);
    return {
        at: (t, a) => {
            const cr = obsTimes.map((ot, i) => kr(t, a, ot, obsAmp[i]));
            const ct = cr.map(c => c + d2);
            let mr = 0, mt = 0;
            for (let i = 0; i < k; i++) { mr += cr[i] * alpha[i]; mt += ct[i] * alpha[i]; }
            const wr = cholSolve(L, cr), wt = cholSolve(L, ct);
            let qr = 0, qt = 0;
            for (let i = 0; i < k; i++) { qr += cr[i] * wr[i]; qt += ct[i] * wt[i]; }
            const priorR = a * a * s2;
            return {
                rMean: clamp(mr), totalMean: clamp(mt),
                rVar: Math.max(0, priorR - qr),
                totalVar: Math.max(1e-6, priorR + d2 - qt),
            };
        },
    };
}

/**
 * GP posterior of the T calibration terms on `times` for FIXED residuals `y`.
 * `causal` conditions each time on the observations at or before it.
 * (The series builder re-derives residuals per update — see
 * computeTestosteroneSeries; this helper is the plain GP, kept for tests.)
 */
export function testosteroneGP(
    obsTimes: number[],
    y: number[],
    obsAmp: number[],
    times: number[],
    amp: number[],
    t0SdLog: number,
    mode: TCalibrationMode = 'retrospective',
    p = T_CALIBRATION
): TGPResult {
    const order = obsTimes.map((_, i) => i).sort((a, b) => obsTimes[a] - obsTimes[b]);
    const ot = order.map(i => obsTimes[i]), oy = order.map(i => y[i]), oa = order.map(i => obsAmp[i]);
    const cache = new Map<number, TGPPosterior>();
    const post = (k: number) => {
        let g = cache.get(k);
        if (!g) { g = conditionTGP(ot.slice(0, k), oy.slice(0, k), oa.slice(0, k), t0SdLog, p); cache.set(k, g); }
        return g;
    };
    const out: TGPResult = { rMean: [], rVar: [], totalMean: [], totalVar: [] };
    times.forEach((t, q) => {
        let k = ot.length;
        if (mode === 'causal') { k = 0; while (k < ot.length && ot[k] <= t) k++; }
        const r = post(k).at(t, amp[q]);
        out.rMean.push(r.rMean); out.rVar.push(r.rVar); out.totalMean.push(r.totalMean); out.totalVar.push(r.totalVar);
    });
    return out;
}

/** −2·log posterior (up to constants) of ηT under the GP marginal likelihood. */
function etaObjective(obsTimes: number[], y: number[], obsAmp: number[], t0SdLog: number, eta: number, p = T_CALIBRATION): number {
    const n = obsTimes.length;
    const s2 = p.priorSdLog * p.priorSdLog, d2 = t0SdLog * t0SdLog, e2 = p.noiseSdLog * p.noiseSdLog;
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
        obsAmp[i] * obsAmp[j] * s2 * Math.exp(-Math.abs(obsTimes[i] - obsTimes[j]) / p.lengthScaleH) + d2 + (i === j ? e2 : 0)));
    const alpha = cholSolve(cholesky(A), y);
    let quad = 0;
    for (let i = 0; i < n; i++) quad += y[i] * alpha[i];
    return quad + (eta * eta) / (p.etaPriorSd * p.etaPriorSd);
}

interface EtaFit { eta: number; sd: number; estimated: boolean; }

/**
 * MAP of ηT (golden section; each evaluation integrates the T ODE) with a
 * Laplace SD from a numerical second derivative. Returns the prior
 * (0, etaPriorSd) with fewer than `etaMinPostDoseLabs` post-treatment labs.
 */
function fitEtaT(
    obs: TestosteroneObservation[],
    firstDoseH: number,
    structAt: (eta: number) => (t: number) => number,
    obsAmp: number[],
    T0: number,
    t0SdLog: number,
    p = T_CALIBRATION
): EtaFit {
    const postDose = obs.filter(o => o.timeH >= firstDoseH).length;
    if (postDose < p.etaMinPostDoseLabs) return { eta: 0, sd: p.etaPriorSd, estimated: false };
    const times = obs.map(o => o.timeH);
    const J = (eta: number) => {
        const f = structAt(eta);
        return etaObjective(times, obs.map(o => Math.log(o.ngdL / Math.max(f(o.timeH) * T0, 1e-6))), obsAmp, t0SdLog, eta, p);
    };
    let [a, b] = p.etaBounds;
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a);
    let fc = J(c), fd = J(d);
    for (let it = 0; it < 28; it++) {
        if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = J(c); }
        else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = J(d); }
    }
    const eta = (a + b) / 2;
    const h = 0.05;
    const second = (J(eta + h) - 2 * J(eta) + J(eta - h)) / (h * h);
    const sd = second > 1e-6 ? Math.min(p.etaPriorSd, Math.sqrt(2 / second)) : p.etaPriorSd;
    return { eta, sd, estimated: true };
}

/** One evaluated point of the calibrated T posterior. */
interface TPoint {
    values: number;
    tFraction: number;
    logSd: number;
    fractionLogSd: number;
    endogenousFraction: number;
}
const T_POINT_FIELDS = ['values', 'tFraction', 'logSd', 'fractionLogSd', 'endogenousFraction'] as const;
export type TSeriesField = typeof T_POINT_FIELDS[number];

/**
 * Build the endogenous testosterone series on a simulation grid.
 *
 * `e2PGmL` is the E2 exposure driving suppression — the population drug curve
 * from runSimulation, or the PERSONALISED drug curve when called from the
 * coupled E2/T estimation (computeCoupledSimulationWithCI), so both predictions
 * share the same individual parameters.
 *
 * Calibration is organised in SEGMENTS between update times (distinct T lab
 * times). In segment k the state is: labs visible = those drawn at or before
 * the segment start; ηT refit on exactly those labs; ALL visible residuals
 * recomputed against that ηT's structural curve; GP conditioned on them.
 * Causal mode has one segment per update; retrospective mode a single
 * segment containing every lab — the same code path, so both agree once all
 * labs are visible. Exact values on both sides of every update are stored as
 * knots, and all readers interpolate only WITHIN a segment
 * (interpolateTSeries), so no value ever mixes pre- and post-update states.
 */
export function computeTestosteroneSeries(
    timeH: number[],
    e2PGmL: number[],
    byCompound: SimulationResult['byCompound'],
    opts: TestosteroneModelOptions = {}
): TestosteroneSeries {
    const mode: TCalibrationMode = opts.mode ?? 'retrospective';
    const P = T_CALIBRATION;
    const observations = (opts.observations ?? [])
        .filter(o => Number.isFinite(o.timeH) && Number.isFinite(o.ngdL) && o.ngdL > 0)
        .sort((a, b) => a.timeH - b.timeH);
    const firstDoseH = opts.firstDoseH ?? Infinity;
    const hasSetting = typeof opts.baselineNgdL === 'number' && Number.isFinite(opts.baselineNgdL) && opts.baselineNgdL > 0;
    const T0 = hasSetting ? opts.baselineNgdL! : TESTOSTERONE_MODEL.baselineNgdL;
    const t0SdLog = hasSetting ? P.t0SdLogSetting : P.t0SdLogPopulation;
    const n = timeH.length;

    const cache = new Map<number, number[]>();
    const trajectory = (eta: number): number[] => {
        const key = Math.round(eta * 1e6) / 1e6;
        let tr = cache.get(key);
        if (!tr) { tr = integrateTFraction(timeH, e2PGmL, byCompound, key).v; cache.set(key, tr); }
        return tr;
    };
    // Continuous in t for a fixed ηT (no calibration state inside) → safe to interpolate.
    const trajAt = (eta: number, t: number) => interpolateSeries(timeH, trajectory(eta), t) ?? 1;
    const explore = (eta: number) => {
        const r = integrateTFraction(timeH, e2PGmL, byCompound, eta, 2);
        return (t: number) => interpolateSeries(r.t, r.v, t) ?? 1;
    };
    const popFrac = trajectory(0);
    const amp = popFrac.map(responseAmplitude);
    const ampAt = (t: number) => interpolateSeries(timeH, amp, t) ?? 0;
    const obsAmp = observations.map(o => ampAt(o.timeH));

    // Update times and the number of labs visible in each segment.
    const updateTimesH: number[] = [];
    const visibleCounts: number[] = [0];
    if (mode === 'causal') {
        for (let i = 0; i < observations.length; i++) {
            const t = observations[i].timeH;
            if (updateTimesH.length === 0 || updateTimesH[updateTimesH.length - 1] !== t) updateTimesH.push(t);
            visibleCounts[updateTimesH.length] = i + 1;
        }
    } else {
        visibleCounts[0] = observations.length;
    }

    interface Segment { fit: EtaFit; gp: TGPPosterior; }
    const segments: Segment[] = visibleCounts.map(m => {
        const vis = observations.slice(0, m);
        const visAmp = obsAmp.slice(0, m);
        const fit = fitEtaT(vis, firstDoseH, explore, visAmp, T0, t0SdLog);
        // Residuals of ALL visible labs against THIS segment's structural curve.
        const y = vis.map(o => Math.log(o.ngdL / Math.max(trajAt(fit.eta, o.timeH) * T0, 1e-6)));
        return { fit, gp: conditionTGP(vis.map(o => o.timeH), y, visAmp, t0SdLog) };
    });
    const segmentOf = (t: number) => {
        let k = 0;
        while (k < updateTimesH.length && updateTimesH[k] <= t) k++;
        return k;
    };

    const rhoMean = ENDOGENOUS_E2_RHO_MEAN;
    const h = 0.05;
    const evalPoint = (seg: Segment, t: number, structFrac: number, a: number, dLogS: number): TPoint => {
        const r = seg.gp.at(t, a);
        const etaVar = dLogS * dLogS * seg.fit.sd * seg.fit.sd;
        const vf = r.rVar + etaVar;
        const tFraction = structFrac * Math.exp(r.rMean);
        return {
            values: T0 * structFrac * Math.exp(r.totalMean),
            tFraction,
            logSd: Math.sqrt(r.totalVar + etaVar),
            fractionLogSd: Math.sqrt(vf),
            // Mean endogenous multiplier E[ρ]·E[T/T0] + (1 − E[ρ]), lognormal mean.
            endogenousFraction: rhoMean * tFraction * Math.exp(0.5 * vf) + (1 - rhoMean),
        };
    };
    const evalAt = (k: number, t: number): TPoint => {
        const seg = segments[k];
        const eta = seg.fit.eta;
        const dLogS = (Math.log(trajAt(eta + h, t)) - Math.log(trajAt(eta - h, t))) / (2 * h);
        return evalPoint(seg, t, trajAt(eta, t), ampAt(t), dLogS);
    };

    const series = {
        values: new Array<number>(n), tFraction: new Array<number>(n), logSd: new Array<number>(n),
        fractionLogSd: new Array<number>(n), endogenousFraction: new Array<number>(n),
    };
    for (let i = 0; i < n; i++) {
        const k = segmentOf(timeH[i]);
        const seg = segments[k];
        const eta = seg.fit.eta;
        const dLogS = (Math.log(trajectory(eta + h)[i]) - Math.log(trajectory(eta - h)[i])) / (2 * h);
        const pt = evalPoint(seg, timeH[i], trajectory(eta)[i], amp[i], dLogS);
        for (const f of T_POINT_FIELDS) series[f][i] = pt[f];
    }
    // Exact values on both sides of each update: before = previous segment's
    // state at the update time, after = the new segment's state.
    const knotsBefore = updateTimesH.map((u, j) => evalAt(j, u));
    const knotsAfter = updateTimesH.map((u, j) => evalAt(j + 1, u));

    // Personal T0 actually implied by the data: T0·exp(E[δ0]) at the first grid
    // point without drug effect, from the final segment.
    const preIdx = amp.findIndex(x => x < 1e-6);
    const last = segments[segments.length - 1];
    const personalT0 = preIdx >= 0 ? T0 * Math.exp(last.gp.at(timeH[preIdx], 0).totalMean) : T0;
    const pre = observations.filter(o => o.timeH < firstDoseH);
    return {
        unit: 'ng/dL',
        baselineNgdL: personalT0,
        baselineSource: pre.length > 0 ? 'lab' : hasSetting ? 'setting' : 'population',
        mode,
        ...series,
        populationValues: popFrac.map(f => f * T0),
        updateTimesH,
        knotsBefore,
        knotsAfter,
        observationCount: observations.length,
        postDoseObservationCount: observations.length - pre.length,
        etaT: last.fit.eta, etaTSd: last.fit.sd, etaTEstimated: last.fit.estimated,
    };
}

/**
 * Read a T-series field at `hour` without ever interpolating across a
 * calibration update: inside a segment the grid values are interpolated
 * linearly; at a segment edge the exact knot (left limit before an update,
 * new state at it) replaces the neighbour from the other segment.
 */
export function interpolateTSeries(timeH: number[], series: TestosteroneSeries, field: TSeriesField, hour: number): number | null {
    const vals = series[field];
    const n = timeH.length;
    if (n === 0) return null;
    const ups = series.updateTimesH ?? [];
    if (ups.length === 0) return interpolateSeries(timeH, vals, hour);
    let k = 0;
    while (k < ups.length && ups[k] <= hour) k++;
    const segStart = k > 0 ? ups[k - 1] : -Infinity;
    const segEnd = k < ups.length ? ups[k] : Infinity;
    // Bracketing grid indices.
    let lo = -1, hi = -1;
    if (hour <= timeH[0]) hi = 0;
    else if (hour >= timeH[n - 1]) lo = n - 1;
    else {
        let a = 0, b = n - 1;
        while (b - a > 1) { const m = (a + b) >> 1; if (timeH[m] <= hour) a = m; else b = m; }
        lo = a; hi = b;
    }
    let left: [number, number] | null = null;
    let right: [number, number] | null = null;
    if (lo >= 0) left = timeH[lo] >= segStart ? [timeH[lo], vals[lo]] : [segStart, series.knotsAfter![k - 1][field]];
    if (hi >= 0) right = timeH[hi] < segEnd ? [timeH[hi], vals[hi]] : [segEnd, series.knotsBefore![k][field]];
    if (hour === segStart && k > 0) return series.knotsAfter![k - 1][field];
    if (!left) return right![1];
    if (!right) return left[1];
    if (right[0] === left[0]) return left[1];
    return left[1] + (right[1] - left[1]) * (hour - left[0]) / (right[0] - left[0]);
}

// ── Shared posterior draws (common random numbers) ──────────────────────────
// One fixed batch of standard-normal draws is reused for every time point and
// every consumer, so uncertainty bands are smooth in time and the endogenous
// E2 samples are built from the SAME ρ / B / T draws everywhere.

/** Deterministic PRNG (mulberry32) + Box–Muller. */
function makeNormals(count: number, seed: number): number[] {
    let a = seed >>> 0;
    const rand = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out: number[] = [];
    while (out.length < count) {
        const u = Math.max(rand(), 1e-12), v = rand();
        const r = Math.sqrt(-2 * Math.log(u));
        out.push(r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v));
    }
    return out.slice(0, count);
}

export const POSTERIOR_DRAWS = 256;
/** Independent standard normals for: drug-E2 residual, T, ρ, B. */
export const SHARED_DRAWS = {
    drug: makeNormals(POSTERIOR_DRAWS, 0xE2),
    t: makeNormals(POSTERIOR_DRAWS, 0x7E57),
    rho: makeNormals(POSTERIOR_DRAWS, 0x2B0),
    baseline: makeNormals(POSTERIOR_DRAWS, 0xBA5E),
};

const logit = (p: number) => Math.log(p / (1 - p));
const logistic = (x: number) => 1 / (1 + Math.exp(-x));
/** ρ draws (logit-normal prior) — the same batch everywhere. */
export const RHO_DRAWS = SHARED_DRAWS.rho.map(z =>
    logistic(logit(ENDOGENOUS_E2.coupledShareMedian) + ENDOGENOUS_E2.coupledShareSdLogit * z));
/** E[ρ] under the prior, evaluated on the shared draws (so mean and samples agree). */
export const ENDOGENOUS_E2_RHO_MEAN = RHO_DRAWS.reduce((s, x) => s + x, 0) / RHO_DRAWS.length;

/**
 * Time-varying endogenous E2 context shared by the calibration layers (EKF,
 * OU-Kalman, MIPD). `fractionAt(t)` is the MEAN endogenous multiplier
 * E[ρ·T/T0 + 1 − ρ] that scales the pre-treatment baseline B; the T median and
 * log-SD let callers draw posterior samples consistently.
 */
export interface EndogenousE2Context {
    fractionAt: (timeH: number) => number;
    tFractionAt: (timeH: number) => number;
    tLogSdAt: (timeH: number) => number;
    defaultBaselinePGmL: number;
}

/**
 * Build the endogenous-E2 context from a simulation that carries a
 * testosterone series; returns undefined (legacy constant-baseline behaviour)
 * when the testosterone model was off.
 */
export function makeEndogenousE2Context(sim: SimulationResult | null | undefined): EndogenousE2Context | undefined {
    const series = sim?.testosterone;
    if (!sim || !series || series.endogenousFraction.length !== sim.timeH.length) return undefined;
    const timeH = sim.timeH;
    return {
        fractionAt: (t: number) => interpolateTSeries(timeH, series, 'endogenousFraction', t) ?? 1,
        tFractionAt: (t: number) => interpolateTSeries(timeH, series, 'tFraction', t) ?? 1,
        tLogSdAt: (t: number) => interpolateTSeries(timeH, series, 'fractionLogSd', t) ?? 0,
        defaultBaselinePGmL: ENDOGENOUS_E2.baselineDefaultPGmL,
    };
}

/**
 * Endogenous E2 (pg/mL, posterior mean) at `timeH`. Without a context this is
 * the legacy constant pre-dose-lab baseline (0 when none); with one, the
 * baseline (or the population default) times the mean endogenous multiplier.
 */
export function resolveEndogenousE2(
    labBaselinePGmL: number | undefined,
    timeH: number,
    ctx?: EndogenousE2Context
): number {
    const lab = (labBaselinePGmL !== undefined && Number.isFinite(labBaselinePGmL) && labBaselinePGmL > 0)
        ? labBaselinePGmL
        : undefined;
    if (!ctx) return lab ?? 0;
    const base = lab ?? ctx.defaultBaselinePGmL;
    const f = ctx.fractionAt(timeH);
    return base * (Number.isFinite(f) ? Math.max(0, f) : 1);
}

/**
 * Posterior samples of endogenous E2 at `timeH` using the shared draws:
 * B_s · (ρ_s · (T/T0)·exp(sd_T·z_s) + 1 − ρ_s). B has a small SD when it came
 * from pre-treatment labs and the wide population prior otherwise. Writes into
 * `out` (length POSTERIOR_DRAWS) to avoid per-point allocation.
 */
export function sampleEndogenousE2(
    labBaselinePGmL: number | undefined,
    timeH: number,
    ctx: EndogenousE2Context,
    out: number[]
): void {
    const hasLab = labBaselinePGmL !== undefined && Number.isFinite(labBaselinePGmL) && labBaselinePGmL > 0;
    const B = hasLab ? labBaselinePGmL! : ctx.defaultBaselinePGmL;
    const sdB = hasLab ? ENDOGENOUS_E2.baselineLabSdLog : ENDOGENOUS_E2.baselineDefaultSdLog;
    // Median-centred lognormal for B (its mean is used for the point estimate's scale).
    const f = ctx.tFractionAt(timeH);
    const sdT = ctx.tLogSdAt(timeH);
    for (let s = 0; s < POSTERIOR_DRAWS; s++) {
        const b = B * Math.exp(sdB * SHARED_DRAWS.baseline[s] - 0.5 * sdB * sdB);
        const rho = RHO_DRAWS[s];
        out[s] = b * (rho * f * Math.exp(sdT * SHARED_DRAWS.t[s]) + (1 - rho));
    }
}

/**
 * Estradiol undecylate (EU / 十一酸雌二醇) intramuscular depot — "im-depot-v1".
 *
 * EU is a long-chain (undecanoate) ester. Its hallmark — a duration of action far
 * longer than estradiol valerate — is an ABSORPTION (flip-flop) phenomenon, NOT
 * slow clearance: the oil depot releases drug very slowly (rate-limiting `ka`),
 * while the freed estradiol is cleared at the ordinary free-E2 rate
 * (`CorePK.kClear`). The depot is therefore modeled as a single slow source
 * feeding a one-compartment central pool — which the shared {@link _analytic3C}
 * solver reproduces exactly when ester cleavage (`kCleave`) is fast relative to
 * release (so the cleavage transit is effectively instantaneous and the curve is
 * insensitive to its precise value).
 *
 * Public human PK for EU is sparse and dated, so these are CONFIGURABLE
 * ENGINEERING PRIORS, not validated clinical constants. They were calibrated by
 * least squares to the few reported single-dose and repeat-dose anchors:
 *   - single 100 mg IM:  E2 ≈ 500 pg/mL on day 1, ≈ 340 pg/mL on day 14
 *   - 100 mg monthly:    trough ≈ 486–560 pg/mL (month 3), ≈ 540–598 (month 6)
 * The fitted curve lands inside every one of those ranges (day1 ≈ 470, day14 ≈
 * 364, m3 trough ≈ 495, m6 trough ≈ 579 pg/mL at 70 kg). `releaseScale` is an
 * engineering exposure-scaling term that maps ester dose → observable free-E2
 * exposure; it is deliberately kept SEPARATE from any clinical bioavailability
 * figure and should be re-fit against real lab data before being treated as
 * settled. Calibration against a user's own labs flows in automatically via the
 * shared E2 EKF (EU is an estradiol ester, not an anti-androgen).
 */
export const EU_DEPOT_PK = {
    ka: 0.00082,        // h^-1  slow depot release; rate-limiting (t½ ≈ 35 d)
    kCleave: 2.0,       // h^-1  ester cleavage transit (fast → ~one-compartment)
    releaseScale: 0.542 // fraction of ester dose surfacing as free-E2 exposure
};

/**
 * Specification for a non-E2 anti-androgen compound. The registry below drives
 * the PK engine, the personal-model CI layer, and the UI so that adding another
 * anti-androgen later only requires registering one more entry here.
 */
export interface AntiandrogenSpec {
    ester: Ester;
    /** Unit the concentration values are stored in (always ng/mL today). */
    nativeUnit: ConcUnit;
    /** Chart / UI accent color. */
    color: string;
    /** Population PK log-variance used for the confidence band. */
    popLogVar: number;
    /** Upper clamp for adjusted value & CI bounds, in the native unit. */
    ciMaxNative: number;
    /** Whether the compound inherits the E2-inferred adherence amplitude. */
    adherenceFromE2: boolean;
    /** Convert a precomputed central-compartment amount (mg) to native conc. */
    concFromAmountMG: (amountMG: number, weightKG: number) => number;
}

export const ANTIANDROGENS: Partial<Record<Ester, AntiandrogenSpec>> = {
    [Ester.CPA]: {
        ester: Ester.CPA,
        nativeUnit: 'ng/mL',
        color: '#8b5cf6',
        popLogVar: CPA_2COMP_PK.popLogVar,
        ciMaxNative: 500,
        adherenceFromE2: true,
        concFromAmountMG: (amountMG, weightKG) => {
            const v1mL = CPA_2COMP_PK.V1_per_kg * weightKG * 1000;
            return v1mL > 0 ? Math.max(0, (amountMG * 1e6) / v1mL) : 0;
        },
    },
    [Ester.BICA]: {
        ester: Ester.BICA,
        nativeUnit: 'ng/mL',
        color: '#f59e0b',
        popLogVar: BICA_PK.popLogVar,
        ciMaxNative: 20000,
        adherenceFromE2: false,
        // amount (mg) / V/F (L) -> mg/L; ×1000 -> ng/mL
        concFromAmountMG: (amountMG) => Math.max(0, (amountMG / BICA_PK.vOverF) * 1000),
    },
    [Ester.SPL]: {
        ester: Ester.SPL,
        nativeUnit: 'ng/mL',
        color: '#0ea5e9',
        popLogVar: SPL_PK.popLogVar,
        ciMaxNative: 2000,
        adherenceFromE2: false,
        // canrenone amount (mg) / V/F (L) -> mg/L; ×1000 -> ng/mL
        concFromAmountMG: (amountMG) => Math.max(0, (amountMG / SPL_PK.vOverF) * 1000),
    },
};

export const ANTIANDROGEN_ESTERS = Object.keys(ANTIANDROGENS) as Ester[];

/** True when the ester is a tracked non-E2 anti-androgen (CPA / BICA / SPL / …). */
export function isAntiandrogen(ester: Ester): boolean {
    return Object.prototype.hasOwnProperty.call(ANTIANDROGENS, ester);
}

/**
 * Pick which anti-androgen "owns" the shared right axis / headline: the most
 * recently dosed anti-androgen. CPA and bicalutamide are clinical alternatives
 * with ~1000× different scales, so only one is shown at a time — whichever the
 * user took last.
 *
 * When `nowH` is given, doses already taken (timeH ≤ now) win; if every
 * anti-androgen dose is still in the future, the soonest upcoming one is used.
 * When `nowH` is omitted, the latest dose by time is chosen.
 *
 * Tie-break: when two anti-androgen doses share the winning timeH, the one
 * appearing later in `events` wins (i.e. the most recently recorded), so the
 * result is deterministic for a given input order.
 */
export function pickPrimaryAntiandrogen(events: DoseEvent[], nowH?: number): Ester | null {
    const aa = events.filter(e => isAntiandrogen(e.ester));
    if (aa.length === 0) return null;
    if (nowH === undefined) {
        return aa.reduce((a, b) => (b.timeH >= a.timeH ? b : a)).ester;
    }
    const past = aa.filter(e => e.timeH <= nowH);
    if (past.length > 0) {
        return past.reduce((a, b) => (b.timeH >= a.timeH ? b : a)).ester;
    }
    return aa.reduce((a, b) => (b.timeH < a.timeH ? b : a)).ester;
}

/**
 * Scale a native (ng/mL) anti-androgen concentration into a display unit,
 * auto-promoting to µg/mL once the value reaches 1000 ng/mL so large compounds
 * (bicalutamide) don't render as "9000 ng/mL".
 */
export function formatAntiandrogenConc(
    ngml: number,
    spec: AntiandrogenSpec
): { value: number; unit: ConcUnit } {
    if (spec.nativeUnit === 'ng/mL' && ngml >= 1000) {
        return { value: ngml / 1000, unit: 'ug/mL' };
    }
    return { value: ngml, unit: spec.nativeUnit };
}

const EsterInfo = {
    [Ester.E2]: { name: "Estradiol", mw: 272.38 },
    [Ester.EB]: { name: "Estradiol Benzoate", mw: 376.50 },
    [Ester.EV]: { name: "Estradiol Valerate", mw: 356.50 },
    [Ester.EC]: { name: "Estradiol Cypionate", mw: 396.58 },
    [Ester.EN]: { name: "Estradiol Enanthate", mw: 384.56 },
    [Ester.EU]: { name: "Estradiol Undecylate", mw: 440.66 },
    [Ester.CPA]: { name: "Cyproterone Acetate", mw: 416.94 },
    [Ester.BICA]: { name: "Bicalutamide", mw: 430.37 },
    [Ester.SPL]: { name: "Spironolactone", mw: 416.57 }
};

/**
 * Convert a compound / ester dose into estradiol-equivalent molar mass scaling.
 */
export function getToE2Factor(ester: Ester): number {
    if (ester === Ester.E2) return 1.0;
    return EsterInfo[Ester.E2].mw / EsterInfo[ester].mw;
}

// EU is a single slow depot (Frac_fast = 0 → only the `k1_slow` source contributes),
// so its absorption is the rate-limiting flip-flop release `EU_DEPOT_PK.ka`. The
// `k1_fast` entry is never exercised (its dose fraction is 0) but is set to `ka`
// for definiteness rather than left to the generic fallback.
const TwoPartDepotPK = {
    Frac_fast: { [Ester.EB]: 0.90, [Ester.EV]: 0.40, [Ester.EC]: 0.229164549, [Ester.EN]: 0.05, [Ester.EU]: 0, [Ester.E2]: 1.0 },
    k1_fast: { [Ester.EB]: 0.144, [Ester.EV]: 0.0216, [Ester.EC]: 0.005035046, [Ester.EN]: 0.0010, [Ester.EU]: EU_DEPOT_PK.ka, [Ester.E2]: 0.5 },
    k1_slow: { [Ester.EB]: 0.114, [Ester.EV]: 0.0138, [Ester.EC]: 0.004510574, [Ester.EN]: 0.0050, [Ester.EU]: EU_DEPOT_PK.ka, [Ester.E2]: 0 }
};

const InjectionPK = {
    formationFraction: { [Ester.EB]: 0.1092, [Ester.EV]: 0.0623, [Ester.EC]: 0.1173, [Ester.EN]: 0.12, [Ester.EU]: EU_DEPOT_PK.releaseScale, [Ester.E2]: 1.0 }
};

const EsterPK = {
    k2: { [Ester.EB]: 0.090, [Ester.EV]: 0.070, [Ester.EC]: 0.045, [Ester.EN]: 0.015, [Ester.EU]: EU_DEPOT_PK.kCleave, [Ester.E2]: 0 }
};

const OralPK = {
    kAbsE2: 0.32,
    kAbsEV: 0.05,
    bioavailability: 0.03,
    kAbsSL: 1.8
};

// Deterministic ordering keeps the serialized tier index stable across UI and PK code.
export const SL_TIER_ORDER = ["quick", "casual", "standard", "strict"] as const;

export const SublingualTierParams = {
    quick: { theta: 0.01, hold: 2 },
    casual: { theta: 0.04, hold: 5 },
    standard: { theta: 0.11, hold: 10 },
    strict: { theta: 0.18, hold: 15 }
};

/**
 * Route-specific bioavailability multiplier used to map recorded dose to
 * systemically available hormone amount.
 *
 * This function is intentionally exported because both UI helpers and PK logic
 * need to agree on the same route-specific conversion rules.
 */
export function getBioavailabilityMultiplier(
    route: Route,
    ester: Ester,
    extras: DoseEventExtras = {}
): number {
    const mwFactor = getToE2Factor(ester);

    switch (route) {
        case Route.injection: {
            const formation = InjectionPK.formationFraction[ester] ?? 0.08;
            return formation * mwFactor;
        }
        case Route.oral:
            return OralPK.bioavailability * mwFactor;
        case Route.sublingual: {
            let theta = 0.11;
            if (extras[ExtraKey.sublingualTheta] !== undefined) {
                const customTheta = extras[ExtraKey.sublingualTheta];
                if (typeof customTheta === 'number' && Number.isFinite(customTheta)) {
                    theta = Math.min(1, Math.max(0, customTheta));
                }
            } else if (extras[ExtraKey.sublingualTier] !== undefined) {
                const tierIdx = Math.min(SL_TIER_ORDER.length - 1, Math.max(0, Math.round(extras[ExtraKey.sublingualTier]!)));
                const tierKey = SL_TIER_ORDER[tierIdx] || 'standard';
                theta = SublingualTierParams[tierKey]?.theta ?? 0.11;
            }
            return (theta + (1 - theta) * OralPK.bioavailability) * mwFactor;
        }
        case Route.gel: {
            // Systemic absorbed fraction of the layered model = kPen/(kPen+kLoss),
            // resolved from the event's product id + site + area at compute time.
            const product = getGelProductById(extras[ExtraKey.gelProductId]);
            const siteIdx = Math.min(GEL_SITE_ORDER.length - 1, Math.max(0, Math.round(extras[ExtraKey.gelSite] ?? 0)));
            const site = (GEL_SITE_ORDER[siteIdx] ?? GelSite.arm) as GelSite;
            const areaRaw = extras[ExtraKey.areaCM2];
            const area = (typeof areaRaw === 'number' && areaRaw > 0) ? areaRaw : product.defaultAreaCM2;
            const k = resolveGelKinetics(product, site, product.refDoseMG, area);
            // Match the curve (gelEventCentralAmount): reflect any co-applied product
            // in the reported absorbed fraction. NOTE: the gel curve is built solely
            // by gelEventCentralAmount, so this factor is applied exactly once there.
            return (k.kPen / (k.kPen + k.kLoss)) * gelCoApplicationFactor(extras) * mwFactor;
        }
        case Route.patchApply:
            return 1.0 * mwFactor;
        case Route.patchRemove:
        default:
            return 0;
    }
}

interface PKParams {
    Frac_fast: number;
    k1_fast: number;
    k1_slow: number;
    k2: number;
    k3: number;
    F: number;
    rateMGh: number;
    F_fast: number;
    F_slow: number;
}

/**
 * Resolve one dose event into the low-level PK parameters used by the solvers.
 *
 * Exported because the EKF layer reuses the same route-specific model, but with
 * a learned clearance scaling applied on top.
 */
export function resolveParams(event: DoseEvent): PKParams {
    // Injectables use the lumped slow injection clearance, EXCEPT estradiol
    // undecylate (EU): its long action is an absorption (flip-flop) effect, so the
    // freed estradiol is cleared at the ordinary free-E2 rate. EU only ever appears
    // on the injection route, so keying this on the ester is sufficient.
    const defaultK3 = (event.route === Route.injection && event.ester !== Ester.EU)
        ? CorePK.kClearInjection
        : CorePK.kClear;
    const toE2 = getToE2Factor(event.ester);
    const extras = event.extras ?? {};

    switch (event.route) {
        case Route.injection: {
            const Frac_fast = TwoPartDepotPK.Frac_fast[event.ester] ?? 0.5;
            const k1_fast = (TwoPartDepotPK.k1_fast[event.ester] ?? 0.1) * CorePK.depotK1Corr;
            const k1_slow = (TwoPartDepotPK.k1_slow[event.ester] ?? 0.01) * CorePK.depotK1Corr;
            const k2 = EsterPK.k2[event.ester] ?? 0;
            const F = getBioavailabilityMultiplier(Route.injection, event.ester, extras);
            return { Frac_fast, k1_fast, k1_slow, k2, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }

        case Route.sublingual: {
            let theta = 0.11;
            if (extras[ExtraKey.sublingualTheta] !== undefined) {
                const customTheta = extras[ExtraKey.sublingualTheta];
                if (typeof customTheta === 'number' && Number.isFinite(customTheta)) {
                    theta = Math.min(1, Math.max(0, customTheta));
                }
            } else if (extras[ExtraKey.sublingualTier] !== undefined) {
                const tierRaw = extras[ExtraKey.sublingualTier];
                if (typeof tierRaw === 'number' && Number.isFinite(tierRaw)) {
                    const tierIdx = Math.min(SL_TIER_ORDER.length - 1, Math.max(0, Math.round(tierRaw)));
                    const tierKey = SL_TIER_ORDER[tierIdx] || 'standard';
                    theta = SublingualTierParams[tierKey]?.theta ?? theta;
                }
            }
            const k1_fast = OralPK.kAbsSL;
            const k1_slow = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const k2 = EsterPK.k2[event.ester] ?? 0;
            const F_fast = toE2;
            const F_slow = OralPK.bioavailability * toE2;
            const F = theta * F_fast + (1 - theta) * F_slow;
            return { Frac_fast: theta, k1_fast, k1_slow, k2, k3: defaultK3, F, rateMGh: 0, F_fast, F_slow };
        }

        case Route.gel: {
            const F = getBioavailabilityMultiplier(Route.gel, event.ester, extras);
            const k1 = 0.022;
            return { Frac_fast: 1.0, k1_fast: k1, k1_slow: 0, k2: 0, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }

        case Route.patchApply: {
            const F = getBioavailabilityMultiplier(Route.patchApply, event.ester, extras);
            const releaseRateUGPerDay = extras[ExtraKey.releaseRateUGPerDay];
            const rateMGh = (typeof releaseRateUGPerDay === 'number' && Number.isFinite(releaseRateUGPerDay) && releaseRateUGPerDay > 0)
                ? (releaseRateUGPerDay / 24 / 1000) * F
                : 0;
            if (rateMGh > 0) {
                return { Frac_fast: 1.0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F, rateMGh, F_fast: F, F_slow: F };
            }
            const k1 = 0.0075;
            return { Frac_fast: 1.0, k1_fast: k1, k1_slow: 0, k2: 0, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }

        case Route.patchRemove:
            return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };

        case Route.oral: {
            if (isAntiandrogen(event.ester)) {
                // Anti-androgens (CPA / bicalutamide / spironolactone) are dosed as raw compound
                // mg and their amount is produced by their own model in
                // PrecomputedEventModel; these params are not used for them.
                return {
                    Frac_fast: 1.0,
                    k1_fast: 1.0,
                    k1_slow: 0,
                    k2: 0,
                    k3: 0.017,
                    F: 0.7,
                    rateMGh: 0,
                    F_fast: 0.7,
                    F_slow: 0.7
                };
            }

            const k1Value = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const k2Value = event.ester === Ester.EV ? (EsterPK.k2[Ester.EV] || 0) : 0;
            const F = OralPK.bioavailability * toE2;
            return { Frac_fast: 1.0, k1_fast: k1Value, k1_slow: 0, k2: k2Value, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }
    }

    return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };
}

/**
 * Analytical single-dose oral CPA solution for the central compartment.
 *
 * Exported so the individualized CPA prediction in `logic.ts` can reuse the
 * exact same population model as the baseline simulation.
 */
export function compute2CompCPACentralAmount(doseMG: number, tau: number): number {
    if (tau < 0 || doseMG <= 0) return 0;
    const { F, ka, alpha, beta, k21 } = CPA_2COMP_PK;
    const eps = 1e-8;
    if (Math.abs(alpha - ka) < eps || Math.abs(beta - ka) < eps || Math.abs(alpha - beta) < eps) {
        if (Math.abs(ka - beta) < eps) return Math.max(0, doseMG * F * ka * tau * Math.exp(-beta * tau));
        return Math.max(0, doseMG * F * ka / (ka - beta) * (Math.exp(-beta * tau) - Math.exp(-ka * tau)));
    }
    const A = (k21 - ka) / ((alpha - ka) * (beta - ka));
    const B = (k21 - alpha) / ((ka - alpha) * (beta - alpha));
    const C = (k21 - beta) / ((ka - beta) * (alpha - beta));
    const val = doseMG * F * ka * (
        A * Math.exp(-ka * tau) +
        B * Math.exp(-alpha * tau) +
        C * Math.exp(-beta * tau)
    );
    return Math.max(0, val);
}

/**
 * Analytical single-dose oral bicalutamide central-compartment amount (mg) at
 * elapsed time `tau` hours, using apparent one-compartment first-order
 * absorption / elimination. Dividing this by `BICA_PK.vOverF` (and ×1000)
 * yields ng/mL — see `ANTIANDROGENS[Ester.BICA].concFromAmountMG`.
 */
export function computeBicalutamideAmount(doseMG: number, tau: number): number {
    if (tau < 0 || doseMG <= 0) return 0;
    const { ka, ke } = BICA_PK;
    if (Math.abs(ka - ke) < 1e-9) {
        return Math.max(0, doseMG * ka * tau * Math.exp(-ke * tau));
    }
    return Math.max(0, doseMG * ka / (ka - ke) * (Math.exp(-ke * tau) - Math.exp(-ka * tau)));
}

/**
 * Bicalutamide plasma concentration in ng/mL at a single time point, summed
 * over all past oral BICA doses. Independent of the simulation grid (no time
 * bound), so it is also used directly by unit tests.
 */
export function bicalutamideConcNgML(events: DoseEvent[], timeH: number): number {
    const spec = ANTIANDROGENS[Ester.BICA]!;
    let totalAmountMG = 0;
    for (const ev of events) {
        if (ev.ester !== Ester.BICA || ev.route !== Route.oral) continue;
        if (ev.timeH > timeH) continue;
        totalAmountMG += computeBicalutamideAmount(ev.doseMG, timeH - ev.timeH);
    }
    return spec.concFromAmountMG(totalAmountMG, 0);
}

/**
 * Analytical single-dose oral spironolactone → canrenone amount (mg-equivalent)
 * at elapsed time `tau` hours (apparent one-compartment formation/elimination).
 * Dividing by `SPL_PK.vOverF` (and ×1000) yields canrenone ng/mL.
 */
export function computeSpironolactoneAmount(doseMG: number, tau: number): number {
    if (tau < 0 || doseMG <= 0) return 0;
    const { ka, ke } = SPL_PK;
    if (Math.abs(ka - ke) < 1e-9) {
        return Math.max(0, doseMG * ka * tau * Math.exp(-ke * tau));
    }
    return Math.max(0, doseMG * ka / (ka - ke) * (Math.exp(-ke * tau) - Math.exp(-ka * tau)));
}

/**
 * Closed-form 3-compartment amount model used by the injectable and EV routes.
 */
export function _analytic3C(tau: number, doseMG: number, F: number, k1: number, k2: number, k3: number): number {
    if (k1 <= 0 || doseMG <= 0) return 0;
    const k1_k2 = k1 - k2;
    const k1_k3 = k1 - k3;
    const k2_k3 = k2 - k3;

    if (Math.abs(k1_k2) < 1e-9 || Math.abs(k1_k3) < 1e-9 || Math.abs(k2_k3) < 1e-9) return 0;

    const term1 = Math.exp(-k1 * tau) / (k1_k2 * k1_k3);
    const term2 = Math.exp(-k2 * tau) / (-k1_k2 * k2_k3);
    const term3 = Math.exp(-k3 * tau) / (k1_k3 * k2_k3);

    return doseMG * F * k1 * k2 * (term1 + term2 + term3);
}

/**
 * Standard one-compartment first-order absorption / elimination solution.
 */
export function oneCompAmount(tau: number, doseMG: number, p: PKParams): number {
    const k1 = p.k1_fast;
    if (Math.abs(k1 - p.k3) < 1e-9) {
        return doseMG * p.F * k1 * tau * Math.exp(-p.k3 * tau);
    }
    return doseMG * p.F * k1 / (k1 - p.k3) * (Math.exp(-p.k3 * tau) - Math.exp(-k1 * tau));
}

/**
 * The effective physical-instance id of a patch application: the id recorded in
 * extras at apply time, defaulting to the event's own id (zero extra state).
 * Stored values are normalised to string for comparison so hand-edited numeric
 * ids still pair correctly.
 */
export function patchInstanceIdOf(event: DoseEvent): string {
    const raw = event.extras?.[ExtraKey.patchInstanceId] ?? event.id;
    return String(raw);
}

/**
 * Find the removal event that terminates a patch application.
 *
 * Pairing rule (F22):
 * - A removal R that records `extras.patchRemovalFor` pairs with apply A iff
 *   `R.patchRemovalFor === patchInstanceIdOf(A)` and `R.timeH >= A.timeH`. The
 *   earliest matching removal wins; a targeted removal whose id matches no
 *   apply removes nothing (it never falls back to the legacy rule — that would
 *   re-introduce the "one removal kills every overlapping patch" bug).
 * - A removal WITHOUT `patchRemovalFor` uses the legacy rule: it terminates the
 *   FIRST apply strictly before it (`R.timeH > A.timeH`, unchanged pre-F22
 *   behaviour, so existing data reproduces bit-for-bit).
 *
 * Documented edge cases:
 * - Same-time replacement: an id-targeted removal at exactly the apply time
 *   pairs (`>=`), giving zero wear duration — the patch delivers nothing.
 * - Repeated removals: only the earliest targeted removal terminates a given
 *   apply; later ones target other instances or nothing.
 * - Removal with no active patch: matches nothing; the apply model then wears
 *   until `Number.MAX_VALUE` (unchanged legacy behaviour for that apply).
 *
 * `events` may be in any order; the earliest matching removal by (timeH, input
 * order) is returned, mirroring the old `find` over a time-sorted list.
 */
export function findPatchRemovalForApply(apply: DoseEvent, events: DoseEvent[]): DoseEvent | undefined {
    const applyId = patchInstanceIdOf(apply);
    let bestTargeted: DoseEvent | undefined;
    let bestTargetedTimeH = Infinity;
    let bestLegacy: DoseEvent | undefined;
    let bestLegacyTimeH = Infinity;
    for (const ev of events) {
        if (ev.route !== Route.patchRemove) continue;
        const target = ev.extras?.[ExtraKey.patchRemovalFor];
        if (target !== undefined) {
            // Id-targeted removal: pair only with the referenced instance.
            if (ev.timeH < apply.timeH) continue;
            if (String(target) === applyId && ev.timeH < bestTargetedTimeH) {
                bestTargeted = ev;
                bestTargetedTimeH = ev.timeH;
            }
        } else {
            // Legacy removal (no target id): first removal strictly after the
            // apply — the exact pre-F22 pairing, kept for old data.
            if (ev.timeH <= apply.timeH) continue;
            if (ev.timeH < bestLegacyTimeH) {
                bestLegacy = ev;
                bestLegacyTimeH = ev.timeH;
            }
        }
    }
    return bestTargeted ?? bestLegacy;
}

/**
 * Precomputed per-event model wrapper.
 *
 * The class is kept local to this file because it is only an implementation
 * detail of `runSimulation` and does not need to leak into the rest of the app.
 */
class PrecomputedEventModel {
    private model: (t: number) => number;

    constructor(event: DoseEvent, allEvents: DoseEvent[]) {
        const params = resolveParams(event);
        const startTime = event.timeH;
        const dose = event.doseMG;

        switch (event.route) {
            case Route.injection:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    const doseFast = dose * params.Frac_fast;
                    const doseSlow = dose * (1.0 - params.Frac_fast);

                    return _analytic3C(tau, doseFast, params.F, params.k1_fast, params.k2, params.k3) +
                        _analytic3C(tau, doseSlow, params.F, params.k1_slow, params.k2, params.k3);
                };
                break;
            case Route.gel:
                this.model = (timeH: number) => gelEventCentralAmount(event, timeH - startTime, CorePK.kClear);
                break;
            case Route.oral:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    if (event.ester === Ester.CPA) {
                        return compute2CompCPACentralAmount(dose, tau);
                    }
                    if (event.ester === Ester.BICA) {
                        return computeBicalutamideAmount(dose, tau);
                    }
                    if (event.ester === Ester.SPL) {
                        return computeSpironolactoneAmount(dose, tau);
                    }
                    return oneCompAmount(tau, dose, params);
                };
                break;
            case Route.sublingual:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    if (params.k2 > 0) {
                        const doseF = dose * params.Frac_fast;
                        const doseS = dose * (1.0 - params.Frac_fast);
                        return _analytic3C(tau, doseF, params.F_fast, params.k1_fast, params.k2, params.k3) +
                            _analytic3C(tau, doseS, params.F_slow, params.k1_slow, params.k2, params.k3);
                    } else {
                        const doseF = dose * params.Frac_fast;
                        const doseS = dose * (1.0 - params.Frac_fast);

                        const branch = (d: number, F: number, ka: number, ke: number, t: number) => {
                            if (Math.abs(ka - ke) < 1e-9) return d * F * ka * t * Math.exp(-ke * t);
                            return d * F * ka / (ka - ke) * (Math.exp(-ke * t) - Math.exp(-ka * t));
                        };
                        return branch(doseF, params.F_fast, params.k1_fast, params.k3, tau) +
                            branch(doseS, params.F_slow, params.k1_slow, params.k3, tau);
                    }
                };
                break;
            case Route.patchApply: {
                // F22: pair with the removal that TARGETS this physical patch
                // (extras.patchRemovalFor === instance id); legacy removals
                // without a target keep the old first-removal-after-apply rule.
                const remove = findPatchRemovalForApply(event, allEvents);
                const wearH = (remove?.timeH ?? Number.MAX_VALUE) - startTime;

                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;

                    if (params.rateMGh > 0) {
                        if (tau <= wearH) {
                            return params.rateMGh / params.k3 * (1 - Math.exp(-params.k3 * tau));
                        } else {
                            const amtRemoval = params.rateMGh / params.k3 * (1 - Math.exp(-params.k3 * wearH));
                            return amtRemoval * Math.exp(-params.k3 * (tau - wearH));
                        }
                    }

                    const amtUnderPatch = oneCompAmount(tau, dose, params);
                    if (tau > wearH) {
                        const amtAtRemoval = oneCompAmount(wearH, dose, params);
                        return amtAtRemoval * Math.exp(-params.k3 * (tau - wearH));
                    }
                    return amtUnderPatch;
                };
                break;
            }
            default:
                this.model = () => 0;
        }
    }

    amount(timeH: number): number {
        return this.model(timeH);
    }
}

/**
 * Body weight in kg at simulation time `t`, derived from per-event weight as a
 * step function. The earliest dose's weight is extended backward so points
 * before the first event still get a meaningful Vd. When multiple events share
 * the same `timeH`, the LAST one (most-recently-added under stable sort) wins
 * — this yields a single deterministic value across the whole `t` axis,
 * including the boundary `t === sortedEvents[0].timeH`. Assumes `sortedEvents`
 * is already sorted ascending by `timeH`.
 */
export function weightAtTimeH(sortedEvents: DoseEvent[], t: number): number {
    if (sortedEvents.length === 0) return 70;
    let result = sortedEvents[0].weightKG;
    for (let i = 0; i < sortedEvents.length; i++) {
        if (sortedEvents[i].timeH <= t) {
            result = sortedEvents[i].weightKG;
        } else {
            break;
        }
    }
    return result;
}

/**
 * Main deterministic population simulation engine.
 *
 * This function is kept pure: it only depends on the recorded events (each of
 * which carries its own body weight), which makes it a stable foundation for
 * later calibration layers.
 *
 * F03: the grid always covers the recorded events plus 14 days, AND — when
 * `opts.endTimeH` is given — extends to at least that time. Callers that
 * display a "current" value pass now+buffer here so interpolation at the
 * current time is a real grid point instead of a frozen 14-day tail clamp.
 *
 * When `opts.testosterone` is given, the endogenous testosterone curve (and the
 * derived endogenous-E2 fraction) is attached as `result.testosterone`; the
 * drug curves themselves are unchanged.
 */
export function runSimulation(
    events: DoseEvent[],
    opts?: {
        endTimeH?: number;
        testosterone?: TestosteroneModelOptions | null;
        /**
         * Calibration update times (E2 and T lab times). Each one and the instant
         * just before it (BREAKPOINT_EPS_H earlier) are added to the grid, so the
         * personalised curves are evaluated exactly on both sides of every update
         * and no grid step ever contains an update strictly inside it.
         */
        breakpointsH?: number[];
    }
): SimulationResult | null {
    if (events.length === 0) return null;

    const sortedEvents = [...events].sort((a, b) => a.timeH - b.timeH);
    const precomputed = sortedEvents
        .filter(e => e.route !== Route.patchRemove)
        .map(e => ({ model: new PrecomputedEventModel(e, sortedEvents), ester: e.ester }));

    const startTime = sortedEvents[0].timeH - 24;
    const endTime = Math.max(
        sortedEvents[sortedEvents.length - 1].timeH + (24 * 14),
        opts?.endTimeH ?? -Infinity
    );

    // Determine the finest time resolution needed based on the routes present.
    // Sublingual peaks are narrow (~1–2 h wide) and need a small step to be
    // captured accurately; slow routes like injection tolerate coarser grids.
    const routes = new Set(sortedEvents.map(e => e.route));
    const maxStepH = routes.has(Route.sublingual) ? 0.25
        : routes.has(Route.oral) ? 0.5
        : routes.has(Route.gel) ? 1.0
        : 2.0;
    const steps = Math.max(1000, Math.ceil((endTime - startTime) / maxStepH) + 1);

    const timeH: number[] = [];
    const concPGmL: number[] = [];
    const concPGmL_E2: number[] = [];
    const concPGmL_CPA: number[] = [];
    // Generic per-compound concentration series for every anti-androgen that
    // actually appears in the event list (CPA / bicalutamide / …).
    const presentAntiandrogens = ANTIANDROGEN_ESTERS.filter(
        e => sortedEvents.some(ev => ev.ester === e)
    );
    const byCompound: Partial<Record<Ester, { unit: 'ng/mL'; values: number[] }>> = {};
    for (const e of presentAntiandrogens) {
        byCompound[e] = { unit: 'ng/mL', values: [] };
    }
    let auc = 0;

    const stepSize = (endTime - startTime) / (steps - 1);
    const gridTimes: number[] = [];
    for (let i = 0; i < steps; i++) gridTimes.push(startTime + i * stepSize);
    const extra = (opts?.breakpointsH ?? [])
        .filter(u => Number.isFinite(u) && u > startTime && u <= endTime)
        .flatMap(u => [u - BREAKPOINT_EPS_H, u]);
    if (extra.length > 0) {
        gridTimes.push(...extra);
        gridTimes.sort((a, b) => a - b);
        // Drop near-duplicates (keep the exact breakpoint over a coincident grid point).
        const exact = new Set(extra);
        for (let i = gridTimes.length - 1; i > 0; i--) {
            if (gridTimes[i] - gridTimes[i - 1] < 1e-9) gridTimes.splice(exact.has(gridTimes[i]) ? i - 1 : i, 1);
        }
    }

    for (let i = 0; i < gridTimes.length; i++) {
        const t = gridTimes[i];
        let totalAmountMG_E2 = 0;
        const amountByCompound: Partial<Record<Ester, number>> = {};

        for (const { model, ester } of precomputed) {
            const amount = model.amount(t);
            if (isAntiandrogen(ester)) {
                amountByCompound[ester] = (amountByCompound[ester] ?? 0) + amount;
            } else {
                totalAmountMG_E2 += amount;
            }
        }

        const bodyWeightKG = weightAtTimeH(sortedEvents, t);
        const plasmaVolumeML_E2 = CorePK.vdPerKG * bodyWeightKG * 1000;

        const currentConc_E2 = (totalAmountMG_E2 * 1e9) / plasmaVolumeML_E2;

        // Convert each present anti-androgen's amount to its native (ng/mL) conc.
        let currentConc_CPA = 0;
        for (const e of presentAntiandrogens) {
            const spec = ANTIANDROGENS[e]!;
            const conc = spec.concFromAmountMG(amountByCompound[e] ?? 0, bodyWeightKG);
            byCompound[e]!.values.push(conc);
            if (e === Ester.CPA) currentConc_CPA = conc;
        }

        // Total curve keeps the historical behavior: E2 plus CPA scaled into
        // pg/mL. Bicalutamide is intentionally NOT folded into the total.
        const currentConc = currentConc_E2 + (currentConc_CPA * 1000);

        timeH.push(t);
        concPGmL.push(currentConc);
        concPGmL_E2.push(currentConc_E2);
        concPGmL_CPA.push(currentConc_CPA);

        if (i > 0) {
            auc += 0.5 * (currentConc + concPGmL[i - 1]) * (t - timeH[i - 1]);
        }
    }

    const result: SimulationResult = { timeH, concPGmL, concPGmL_E2, concPGmL_CPA, byCompound, auc };
    if (opts?.testosterone) {
        const firstDose = sortedEvents.find(e => e.route !== Route.patchRemove);
        result.testosterone = computeTestosteroneSeries(timeH, concPGmL_E2, byCompound, {
            ...opts.testosterone,
            firstDoseH: opts.testosterone.firstDoseH ?? firstDose?.timeH,
        });
    }
    return result;
}

/**
 * Shared linear interpolation helper for simulation curves.
 *
 * Keeping the search / interpolation logic in one place avoids subtle drift
 * between total, E2-only, and CPA-only views.
 */
function interpolateSeries(
    timeH: number[],
    conc: number[],
    hour: number
): number | null {
    if (!timeH.length) return null;
    if (hour <= timeH[0]) return conc[0];
    if (hour >= timeH[timeH.length - 1]) return conc[conc.length - 1];

    let low = 0;
    let high = timeH.length - 1;

    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (timeH[mid] === hour) return conc[mid];
        if (timeH[mid] < hour) low = mid;
        else high = mid;
    }

    const t0 = timeH[low];
    const t1 = timeH[high];
    const c0 = conc[low];
    const c1 = conc[high];

    if (t1 === t0) return c0;
    const ratio = (hour - t0) / (t1 - t0);
    return c0 + (c1 - c0) * ratio;
}

/** Offset of the "just before the update" grid point added for each breakpoint (h ≈ 3.6 s). */
export const BREAKPOINT_EPS_H = 0.001;

/**
 * Linear interpolation that never mixes the states on both sides of a
 * calibration update: when an update time lies between the two bracketing grid
 * points, the value from the grid point on the same side of the update as
 * `hour` is held instead. Used for causal-mode personal curves read at
 * arbitrary times (e.g. "now").
 */
export function interpolateNoCross(timeH: number[], values: number[], hour: number, updateTimesH: number[] = []): number | null {
    const n = timeH.length;
    if (n === 0) return null;
    if (hour <= timeH[0]) return values[0];
    if (hour >= timeH[n - 1]) return values[n - 1];
    let a = 0, b = n - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (timeH[m] <= hour) a = m; else b = m; }
    let earlier = false, later = false;
    for (const u of updateTimesH) {
        if (u > timeH[a] && u <= hour) earlier = true;
        if (u > hour && u <= timeH[b]) later = true;
    }
    // The right endpoint already contains an update after `hour` → never use it
    // (holds the last state known at `hour`; with breakpoints on the grid this
    // only happens within BREAKPOINT_EPS_H of the update).
    if (later) return values[a];
    // An update between the left endpoint and `hour`: the left value predates
    // it, the right one is in the same state as `hour`.
    if (earlier) return values[b];
    const t0 = timeH[a], t1 = timeH[b];
    return t1 === t0 ? values[a] : values[a] + (values[b] - values[a]) * (hour - t0) / (t1 - t0);
}

export function interpolateConcentration(sim: SimulationResult, hour: number): number | null {
    return interpolateSeries(sim.timeH, sim.concPGmL, hour);
}

export function interpolateConcentration_E2(sim: SimulationResult, hour: number): number | null {
    return interpolateSeries(sim.timeH, sim.concPGmL_E2, hour);
}

/**
 * Interpolate a non-E2 compound's component curve (native unit, ng/mL) at the
 * given hour. Returns null when the compound is not present in the simulation.
 */
export function interpolateCompoundConcentration(
    sim: SimulationResult,
    ester: Ester,
    hour: number
): number | null {
    const series = sim.byCompound?.[ester];
    if (!series) return null;
    return interpolateSeries(sim.timeH, series.values, hour);
}

export function interpolateConcentration_CPA(sim: SimulationResult, hour: number): number | null {
    return interpolateCompoundConcentration(sim, Ester.CPA, hour);
}

/** Interpolated endogenous testosterone (ng/dL), or null when the model is off. */
export function interpolateTestosterone(sim: SimulationResult, hour: number): number | null {
    const series = sim.testosterone;
    if (!series) return null;
    return interpolateTSeries(sim.timeH, series, 'values', hour);
}

/**
 * Endogenous E2 fraction T(t)/T0 at `hour`; 1 (constant baseline, the legacy
 * behaviour) when the simulation carries no testosterone series.
 */
export function endogenousFractionAt(sim: SimulationResult | null | undefined, hour: number): number {
    const series = sim?.testosterone;
    if (!sim || !series) return 1;
    return interpolateTSeries(sim.timeH, series, 'endogenousFraction', hour) ?? 1;
}
