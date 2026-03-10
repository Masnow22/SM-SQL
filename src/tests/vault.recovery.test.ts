/**
 * SM-SQL Iron Suit — Fuzz / Recovery Drill
 * ==========================================
 *
 * Codex Hardening Standard v1.1 — Gate 3
 *
 * Simulates index corruption by manually injecting malformed lines
 * into `index_log.jsonl`, then boots the engine and asserts that
 * `readIndex()` gracefully skips bad entries and recovers all valid ones.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SMSQLEngine } from '../SMSQLEngine';
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

describe('Index Recovery (Fuzz Drill)', () => {
    it('recovers all valid entries after a truncated JSON line is appended', async () => {
        // ---------------------------------------------------------------
        // Phase 1: Seed 10 legitimate records via the normal API.
        // ---------------------------------------------------------------
        const validIds: string[] = [];
        for (let i = 0; i < 10; i++) {
            const id = await engine.saveMemory(
                `Recovery test record #${i}`,
                'short-term',
                [`recovery`, `r_${i}`]
            );
            validIds.push(id);
        }

        // Verify all 10 are retrievable before corruption.
        const preScan = await engine.scanMemories(100);
        expect(preScan.entries.length).toBe(10);

        // ---------------------------------------------------------------
        // Phase 2: Dispose engine to flush all state, then corrupt the log.
        // ---------------------------------------------------------------
        await engine.dispose();

        const indexLogPath = path.join(baseDir, 'index_log.jsonl');
        const originalContent = await fs.readFile(indexLogPath, 'utf-8');
        const validLineCount = originalContent.split('\n').filter(l => l.trim()).length;

        // Inject 3 different corruption patterns:
        const corruptions = [
            '{"id":"corrupt_001","class":"B","multi',                      // Truncated mid-field
            '{definitely not json at all ¯\\_(ツ)_/¯',                      // Total garbage
            '{"id":"corrupt_003","class":"Z","multiplier":0,"sourceFile',  // Truncated + invalid class
        ];

        const corruptedContent = originalContent + corruptions.join('\n') + '\n';
        await fs.writeFile(indexLogPath, corruptedContent, 'utf-8');

        // Verify corruption is physically present in the file.
        const rawAfterCorrupt = await fs.readFile(indexLogPath, 'utf-8');
        expect(rawAfterCorrupt).toContain('corrupt_001');
        expect(rawAfterCorrupt).toContain('definitely not json');
        expect(rawAfterCorrupt).toContain('corrupt_003');

        // ---------------------------------------------------------------
        // Phase 3: Boot a fresh engine on the corrupted vault.
        //          It MUST NOT crash.
        // ---------------------------------------------------------------
        const recoveredEngine = new SMSQLEngine(baseDir, {
            semanticEnabled: false,
            modelName: 'test-model',
            baseSystemPrompt: 'Recovery test.',
        });

        // This is the critical assertion: init must not throw.
        await expect(recoveredEngine.init()).resolves.toBeUndefined();

        // ---------------------------------------------------------------
        // Phase 4: Assert all 10 original records are intact.
        // ---------------------------------------------------------------
        const postScan = await recoveredEngine.scanMemories(100);
        expect(postScan.entries.length).toBe(10);

        for (const id of validIds) {
            const found = postScan.entries.find(e => e.id === id);
            expect(found).toBeDefined();
        }

        // Verify the corrupted IDs did NOT leak into the index.
        for (const corruptId of ['corrupt_001', 'corrupt_003']) {
            const leaked = postScan.entries.find(e => e.id === corruptId);
            expect(leaked).toBeUndefined();
        }

        await recoveredEngine.dispose();
    });

    it('handles a completely empty index_log.jsonl gracefully', async () => {
        await engine.dispose();

        const indexLogPath = path.join(baseDir, 'index_log.jsonl');
        await fs.writeFile(indexLogPath, '', 'utf-8');

        const freshEngine = new SMSQLEngine(baseDir, {
            semanticEnabled: false,
            modelName: 'test-model',
            baseSystemPrompt: 'Empty recovery test.',
        });

        await expect(freshEngine.init()).resolves.toBeUndefined();

        const scan = await freshEngine.scanMemories(100);
        expect(scan.entries.length).toBe(0);
        expect(freshEngine.getGeneration()).toBeGreaterThanOrEqual(0);

        await freshEngine.dispose();
    });

    it('handles index_log.jsonl with only whitespace / newlines', async () => {
        await engine.dispose();

        const indexLogPath = path.join(baseDir, 'index_log.jsonl');
        await fs.writeFile(indexLogPath, '\n\n   \n  \n\n', 'utf-8');

        const freshEngine = new SMSQLEngine(baseDir, {
            semanticEnabled: false,
            modelName: 'test-model',
            baseSystemPrompt: 'Whitespace recovery test.',
        });

        await expect(freshEngine.init()).resolves.toBeUndefined();
        const scan = await freshEngine.scanMemories(100);
        expect(scan.entries.length).toBe(0);

        await freshEngine.dispose();
    });

    it('recovers partial data after mid-write power failure simulation', async () => {
        // Seed 5 valid records.
        for (let i = 0; i < 5; i++) {
            await engine.saveMemory(`Partial write test #${i}`, 'short-term', ['partial']);
        }
        await engine.dispose();

        const indexLogPath = path.join(baseDir, 'index_log.jsonl');
        const content = await fs.readFile(indexLogPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        // Simulate power failure: truncate the last valid line at 50%.
        const lastLine = lines[lines.length - 1];
        const truncatedLastLine = lastLine.substring(0, Math.floor(lastLine.length / 2));
        lines[lines.length - 1] = truncatedLastLine;

        await fs.writeFile(indexLogPath, lines.join('\n') + '\n', 'utf-8');

        const freshEngine = new SMSQLEngine(baseDir, {
            semanticEnabled: false,
            modelName: 'test-model',
            baseSystemPrompt: 'Power failure test.',
        });

        await expect(freshEngine.init()).resolves.toBeUndefined();

        // Should recover 4 of 5 entries (the truncated 5th is silently dropped).
        const scan = await freshEngine.scanMemories(100);
        expect(scan.entries.length).toBe(4);

        await freshEngine.dispose();
    });
});
