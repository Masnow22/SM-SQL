/**
 * SM-SQL Iron Suit — Storage Baseline Benchmark
 * ================================================
 *
 * Codex Hardening Standard v1.1 — Gate 4
 *
 * Measures 50 concurrent saveMemory appends on an empty vault
 * with LLM fully mocked (zero network). Tracks:
 *   - Total wall-clock time
 *   - p95 latency
 *   - p99 latency
 *
 * Red Lines (from Codex):
 *   - Total time  <= 250ms
 *   - p95 latency <= 20ms
 */

import { bench, describe } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SMSQLEngine } from '../SMSQLEngine';
import { createMockOpenAI } from '../tests/helpers/deterministic';

let vaultSeq = 0;

async function createBenchEngine(): Promise<{ engine: SMSQLEngine; baseDir: string }> {
    vaultSeq++;
    const baseDir = path.join(process.cwd(), `sm_sql_vault_bench_${Date.now()}_${vaultSeq}`);
    const { instance } = createMockOpenAI();

    const engine = new SMSQLEngine(baseDir, {
        semanticEnabled: false,
        modelName: 'bench-model',
        llmClient: instance,
        baseSystemPrompt: 'Benchmark context.',
    });

    await engine.init();
    return { engine, baseDir };
}

async function cleanupBench(baseDir: string): Promise<void> {
    try { await fs.rm(baseDir, { recursive: true, force: true }); } catch { }
}

function percentile(sorted: number[], p: number): number {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

describe('saveMemory Concurrent Append Benchmark', () => {
    bench('50 concurrent saveMemory appends (empty vault)', async () => {
        const { engine, baseDir } = await createBenchEngine();

        const latencies: number[] = [];
        const wallStart = performance.now();

        const promises = Array.from({ length: 50 }, async (_, i) => {
            const t0 = performance.now();
            await engine.saveMemory(
                `Benchmark entry #${i}: testing concurrent write throughput.`,
                'short-term',
                [`bench`, `entry_${i}`]
            );
            latencies.push(performance.now() - t0);
        });

        await Promise.all(promises);

        const wallTotal = performance.now() - wallStart;
        latencies.sort((a, b) => a - b);

        const p95 = percentile(latencies, 95);
        const p99 = percentile(latencies, 99);

        console.log('\n--- SM-SQL Storage Baseline ---');
        console.log(`  Total wall-clock : ${wallTotal.toFixed(2)}ms`);
        console.log(`  p95 latency      : ${p95.toFixed(2)}ms`);
        console.log(`  p99 latency      : ${p99.toFixed(2)}ms`);
        console.log(`  Codex Red Line   : Total <= 250ms, p95 <= 20ms`);
        console.log(`  TOTAL VERDICT    : ${wallTotal <= 250 ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`  P95 VERDICT      : ${p95 <= 20 ? '✅ PASS' : '❌ FAIL'}`);
        console.log('-------------------------------\n');

        await engine.dispose();
        await cleanupBench(baseDir);
    }, { iterations: 5 });
});
