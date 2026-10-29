/**
 * Three-way merge of two sync snapshots (after AtDo's client/vault/merge.ts).
 *
 * When this device and another one both changed the data since the last
 * successful sync, the snapshot both started from (`base`) tells which side
 * changed what, so most "conflicts" merge without asking:
 *
 *   phone A adds a dose, phone B adds a blood report   → both kept
 *   A edits a dose's time, B deletes another dose        → both applied
 *   A and B edit different fields of the same record     → both applied
 *   A and B edit the same field of the same record       → this device wins
 *                                                          (the user just saw it)
 *   one side deletes a record the other side edited      → the edit wins
 *                                                          (nothing is lost silently)
 *
 * Lists are merged per record by `id`; records are flat objects whose nested
 * values (e.g. a blood report's `values`) count as one value. Settings
 * (weight, theme, calibration options, …) are merged as single values.
 */

export const MERGE_LIST_FIELDS = ['events', 'labResults', 'gelProducts', 'bloodReports', 'regimens'] as const;
export const MERGE_VALUE_FIELDS = [
    'weight', 'lang', 'calibrationModel', 'calibrationMode', 'applyE2LearningToCPA',
    'applyCPAInhibitionToE2', 'themeColor', 'themeMode',
] as const;
export const MERGE_FIELDS = [...MERGE_LIST_FIELDS, ...MERGE_VALUE_FIELDS] as const;

type Snapshot = Record<string, unknown>;
type Item = Record<string, unknown> & { id: unknown };

export function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        const other = b as unknown[];
        return a.length === other.length && a.every((v, i) => sameValue(v, other[i]));
    }
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (!sameValue(left[key], right[key])) return false;
    return true;
}

/** Field-level merge of one record; same field changed on both sides → local. */
export function mergeFields(base: Item, local: Item, server: Item): Item {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(server)])) {
        const value = sameValue(local[key], base[key]) ? server[key] : local[key];
        if (value !== undefined) merged[key] = value;
    }
    return merged as Item;
}

const isItem = (v: unknown): v is Item =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && 'id' in v;

const byId = (list: unknown): Map<string, Item> => {
    const map = new Map<string, Item>();
    if (Array.isArray(list)) for (const item of list) if (isItem(item)) map.set(String(item.id), item);
    return map;
};

export function mergeLists(base: unknown, local: unknown, server: unknown): Item[] {
    const b = byId(base);
    const l = byId(local);
    const s = byId(server);
    const resolve = (id: string): Item | null => {
        const bi = b.get(id), li = l.get(id), si = s.get(id);
        if (!bi) {
            // Created after the base: on one side, or (same id) on both.
            if (li && si) return sameValue(li, si) ? si : mergeFields({ id: li.id }, li, si);
            return li ?? si ?? null;
        }
        if (!li && !si) return null;                                   // deleted on both sides
        if (!li) return sameValue(si, bi) ? null : si!;                 // deleted here; kept if edited there
        if (!si) return sameValue(li, bi) ? null : li;                  // deleted there; kept if edited here
        return mergeFields(bi, li, si);
    };
    // Server order first (it already holds the other device's arrangement),
    // then records that only exist on this device, in their local order.
    const out: Item[] = [];
    const seen = new Set<string>();
    for (const id of [...s.keys(), ...l.keys()]) {
        if (seen.has(id)) continue;
        seen.add(id);
        const item = resolve(id);
        if (item) out.push(item);
    }
    return out;
}

/** Merge the synced fields of `local` and `server` against their common `base`. */
export function mergeSnapshots(base: Snapshot, local: Snapshot, server: Snapshot): Snapshot {
    const merged: Snapshot = {};
    for (const field of MERGE_LIST_FIELDS) {
        merged[field] = mergeLists(base[field], local[field], server[field]);
    }
    for (const field of MERGE_VALUE_FIELDS) {
        const value = sameValue(local[field], base[field]) ? server[field] : local[field];
        if (value !== undefined) merged[field] = value;
    }
    return merged;
}

/** The part of a snapshot the merge looks at (what is stored as the base). */
export function pickMergeFields(data: Snapshot): Snapshot {
    const out: Snapshot = {};
    for (const field of MERGE_FIELDS) if (data[field] !== undefined) out[field] = data[field];
    return out;
}
