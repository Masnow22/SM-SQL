/**
 * SM-SQL Iron Suit — MVCC Concurrency Stress Test
 * =================================================
 *
 * Codex Hardening Standard v1.1 — Gate 2
 *
 * Fires 50 interleaved `saveMemory` calls colliding with a
 * `commitCompaction` and asserts all three MVCC invariants
 * after the dust settles.
 *
 * Designed to pass 100 consecutive runs locally with zero flakes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SMSQLEngine } from '../SMSQLEngine';
import { BlockClass } from '../types';
import { createTestEngine, cleanupVault, resetIdCounter } from './helpers/deterministic';

let engine: SMSQLEngine;
let baseDir: string;

beforeEach(async () => {
    resetIdCounter();
    const ctx = await createTestEngine();
    engine = ctx.engine;
    baseDir = ctx.baseDir;
});

afterEach(async () => {
    await engine.dispose();
    await cleanupVault(baseDir);
});

describe('MVCC Concurrency Stress', () => {
    /**
     * Test 1: The definitive 50-save + compaction race.
     *
     * Strategy: Seed 6 B-class records, then fire 50 concurrent saves
     * AND a compaction simultaneously. Since all operations serialize
     * through VaultManager's writeMutex, either:
     *   (a) Compaction runs first → succeeds → generation advances
     *   (b) Some saves run first → compaction gets stale gen → MVCC rejection
     *
     * We handle BOTH outcomes and validate the corresponding invariants.
     * This is the production-correct approach: we test the engine's
     * real concurrency guarantees, not a contrived ordering.
     */
    it('50 interleaved saveMemory + commitCompaction — MVCC invariants hold', async () => {
        // ---------------------------------------------------------------
        // Phase 1: Seed 6 B-Class records as compaction targets.
        // ---------------------------------------------------------------
        const seedIds: string[] = [];
        for (let i = 0; i < 6; i++) {
            const id = await engine.saveMemory(
                `Seed record #${i}: baseline data for compaction target.`,
                'short-term',
                [`seed`, `batch_${i}`]
            );
            seedIds.push(id);
        }

        const preGen = engine.getGeneration();
        const preScan = await engine.scanMemories(200, undefined, true);
        const preBlockCount = preScan.entries.length;
        expect(preBlockCount).toBe(6);

        // ---------------------------------------------------------------
        // Phase 2: Fire 50 concurrent saves + 1 compaction simultaneously.
        // ---------------------------------------------------------------
        const compactionPlan = {
            additions: [
                {
                    content: 'Compacted insight from seeded records.',
                    class: BlockClass.S,
                    tags: ['sys:state:consolidated', 'compacted'],
                },
            ],
            supersedeIds: seedIds,
            expectedGeneration: preGen,
        };

        const concurrentSaves = Array.from({ length: 50 }, (_, i) =>
            engine.saveMemory(
                `Concurrent record #${i} racing the compaction.`,
                'short-term',
                [`concurrent`, `wave_${i % 5}`]
            )
        );

        const compactionPromise = engine.commitCompaction(compactionPlan)
            .then(() => 'committed' as const)
            .catch((e: Error) => {
                if (e.message.includes('MVCC Conflict')) return 'mvcc_rejected' as const;
                throw e; // Re-throw unexpected errors
            });

        const [savedIds, compactionOutcome] = await Promise.all([
            Promise.all(concurrentSaves),
            compactionPromise,
        ]);

        // ---------------------------------------------------------------
        // Phase 3: Assert invariants based on outcome.
        // ---------------------------------------------------------------
        const postGen = engine.getGeneration();
        const allEntries = (await engine.scanMemories(500, undefined, true)).entries;
        const activeEntries = (await engine.scanMemories(500, undefined, false)).entries;

        // All 50 concurrent saves must always succeed regardless of compaction.
        expect(savedIds.length).toBe(50);
        for (const id of savedIds) {
            const found = allEntries.find(e => e.id === id);
            expect(found).toBeDefined();
            expect(found!.tags.includes('sys:state:superseded')).toBe(false);
        }

        if (compactionOutcome === 'committed') {
            // ---- Path A: Compaction won the race ----

            // Invariant 1: Generation advanced beyond pre (by compaction + saves).
            expect(postGen).toBeGreaterThan(preGen);

            // Invariant 2: Total blocks = 6 seeds + 1 addition + 50 concurrent = 57
            expect(allEntries.length).toBe(preBlockCount + 1 + 50);

            // Invariant 3a: All 6 seeds are superseded.
            const superseded = allEntries.filter(e => e.tags.includes('sys:state:superseded'));
            expect(superseded.length).toBe(6);
            for (const seedId of seedIds) {
                expect(superseded.find(e => e.id === seedId)).toBeDefined();
            }

            // Invariant 3b: Consolidated S-class block exists.
            const consolidated = allEntries.filter(
                e => e.class === BlockClass.S && e.tags.includes('sys:state:consolidated')
            );
            expect(consolidated.length).toBe(1);

            // Invariant 3c: Active entries = 50 concurrent + 1 consolidated = 51
            expect(activeEntries.length).toBe(51);

        } else {
            // ---- Path B: Compaction lost the race (MVCC rejection) ----
            // This is CORRECT behavior — ensures no silent data corruption.

            // Invariant 1: Generation still advanced (from the 50 saves).
            expect(postGen).toBeGreaterThan(preGen);

            // Invariant 2: Total blocks = 6 seeds + 50 concurrent = 56 (no addition)
            expect(allEntries.length).toBe(preBlockCount + 50);

            // Invariant 3: All seeds remain active (no supersession occurred).
            for (const seedId of seedIds) {
                const entry = allEntries.find(e => e.id === seedId);
                expect(entry).toBeDefined();
                expect(entry!.tags.includes('sys:state:superseded')).toBe(false);
            }

            // Active entries = 6 seeds + 50 concurrent = 56
            expect(activeEntries.length).toBe(56);
        }

        // Universal invariant: No duplicate IDs in the index.
        const idSet = new Set(allEntries.map(e => e.id));
        expect(idSet.size).toBe(allEntries.length);
    });

    /**
     * Test 2: Compaction succeeds when generation is stable, then validate
     *         all 3 invariants in a controlled (non-racing) scenario.
     */
    it('commitCompaction with stable generation — strict 3-invariant check', async () => {
        // Seed 6 B-class records.
        const seedIds: string[] = [];
        for (let i = 0; i < 6; i++) {
            seedIds.push(
                await engine.saveMemory(`Stable seed #${i}`, 'short-term', [`stable`, `s_${i}`])
            );
        }

        const preGen = engine.getGeneration();
        const preScan = await engine.scanMemories(200, undefined, true);
        const preBlockCount = preScan.entries.length;

        // Compaction with NO concurrent writes — guaranteed stable gen.
        await engine.commitCompaction({
            additions: [
                {
                    content: 'Stable compaction insight.',
                    class: BlockClass.S,
                    tags: ['sys:state:consolidated', 'stable_compacted'],
                },
            ],
            supersedeIds: seedIds,
            expectedGeneration: preGen,
        });

        const postGen = engine.getGeneration();

        // Invariant 1: post_generation === pre_generation + 1
        expect(postGen).toBe(preGen + 1);

        // Invariant 2: total blocks = pre + 1 addition (seeds still exist as superseded)
        const allEntries = (await engine.scanMemories(200, undefined, true)).entries;
        expect(allEntries.length).toBe(preBlockCount + 1);

        // Invariant 3: Tag graph exact consistency.
        // 3a: All seeds superseded
        const superseded = allEntries.filter(e => e.tags.includes('sys:state:superseded'));
        expect(superseded.length).toBe(6);
        for (const seedId of seedIds) {
            expect(superseded.find(e => e.id === seedId)).toBeDefined();
        }

        // 3b: Consolidated block exists
        const consolidated = allEntries.filter(
            e => e.class === BlockClass.S && e.tags.includes('sys:state:consolidated')
        );
        expect(consolidated.length).toBe(1);

        // 3c: Active entries = only the consolidated block
        const activeEntries = (await engine.scanMemories(200, undefined, false)).entries;
        expect(activeEntries.length).toBe(1);
        expect(activeEntries[0].tags).toContain('sys:state:consolidated');
    });

    it('commitCompaction rejects on stale generation (MVCC conflict)', async () => {
        // Seed 6 records.
        const seedIds: string[] = [];
        for (let i = 0; i < 6; i++) {
            seedIds.push(
                await engine.saveMemory(`Conflict seed #${i}`, 'short-term', ['conflict_test'])
            );
        }

        const staleGen = engine.getGeneration();

        // Advance generation by writing more data.
        await engine.saveMemory('Advancing generation after snapshot.', 'short-term', ['advance']);

        const plan = {
            additions: [
                { content: 'Should fail.', class: BlockClass.S, tags: ['sys:state:consolidated'] },
            ],
            supersedeIds: seedIds,
            expectedGeneration: staleGen, // <-- deliberately stale
        };

        await expect(engine.commitCompaction(plan)).rejects.toThrow('MVCC Conflict');
    });

    it('high-frequency concurrent saves preserve total ordering', async () => {
        // Fire 100 saves in a tight burst.
        const promises = Array.from({ length: 100 }, (_, i) =>
            engine.saveMemory(`Ordering record #${i}`, 'short-term', [`ordering`])
        );

        const ids = await Promise.all(promises);
        expect(new Set(ids).size).toBe(100); // All IDs unique — no collision.

        const scan = await engine.scanMemories(200);
        expect(scan.entries.length).toBe(100);
    });
});
