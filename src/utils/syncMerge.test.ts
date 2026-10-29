import { describe, expect, it } from 'vitest';
import { mergeLists, mergeSnapshots } from './syncMerge';

const dose = (id: string, timeH: number, doseMG = 2) => ({ id, route: 'oral', ester: 'EV', timeH, doseMG });

describe('three-way sync merge', () => {
    it('keeps records added on both devices', () => {
        const base = { events: [dose('a', 1)] };
        const local = { events: [dose('a', 1), dose('b', 2)] };
        const server = { events: [dose('a', 1), dose('c', 3)] };
        expect(mergeSnapshots(base, local, server).events).toEqual([dose('a', 1), dose('c', 3), dose('b', 2)]);
    });

    it('applies an edit on one side and a deletion on the other', () => {
        const base = { events: [dose('a', 1), dose('b', 2)] };
        const local = { events: [dose('a', 5), dose('b', 2)] };
        const server = { events: [dose('a', 1)] };
        expect(mergeSnapshots(base, local, server).events).toEqual([dose('a', 5)]);
    });

    it('merges different fields of the same record', () => {
        const base = [dose('a', 1, 2)];
        expect(mergeLists(base, [dose('a', 9, 2)], [dose('a', 1, 4)])).toEqual([dose('a', 9, 4)]);
    });

    it('prefers this device when both changed the same field', () => {
        const base = [dose('a', 1)];
        expect(mergeLists(base, [dose('a', 7)], [dose('a', 8)])).toEqual([dose('a', 7)]);
    });

    it('never loses an edit to a deletion on the other side', () => {
        const base = [dose('a', 1)];
        expect(mergeLists(base, [], [dose('a', 2)])).toEqual([dose('a', 2)]);
        expect(mergeLists(base, [dose('a', 3)], [])).toEqual([dose('a', 3)]);
        expect(mergeLists(base, [], [dose('a', 1)])).toEqual([]);
    });

    it('treats nested values as one value', () => {
        const base = [{ id: 'r', timeH: 1, values: { alt: { value: 20, unit: 'U/L' } } }];
        const local = [{ id: 'r', timeH: 1, values: { alt: { value: 25, unit: 'U/L' } } }];
        const server = [{ id: 'r', timeH: 2, values: { alt: { value: 20, unit: 'U/L' } } }];
        expect(mergeLists(base, local, server)).toEqual([{ id: 'r', timeH: 2, values: { alt: { value: 25, unit: 'U/L' } } }]);
    });

    it('merges settings as single values', () => {
        const base = { weight: 60, themeColor: 'sakura', lang: 'zh-TW' };
        const local = { weight: 62, themeColor: 'sakura', lang: 'zh-TW' };
        const server = { weight: 60, themeColor: 'ocean', lang: 'zh-TW' };
        const merged = mergeSnapshots(base, local, server);
        expect(merged.weight).toBe(62);
        expect(merged.themeColor).toBe('ocean');
        expect(merged.lang).toBe('zh-TW');
    });

    it('unions lists when the base predates a field (older client)', () => {
        const merged = mergeSnapshots({}, { regimens: [{ id: 'x' }] }, { regimens: [{ id: 'y' }] });
        expect(merged.regimens).toEqual([{ id: 'y' }, { id: 'x' }]);
    });
});
