import { SMSQLEngine } from '../SMSQLEngine';
import { BlockClass, CompactionPlan, MemoryBlockDTO } from '../types';

/**
 * System 3: Dream Consolidator (Subconscious Janitor)
 *
 * This worker runs in the background to identify patterns across fragmented memories
 * and synthesize them into high-level "Core Insights" or "Preferences".
 */
export class DreamConsolidatorWorker {
    private isRunning = false;
    private engine: SMSQLEngine;

    constructor(engine: SMSQLEngine) {
        this.engine = engine;
    }

    public start(intervalMs: number = 60000) {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log('[System 3] Dream Consolidator Worker started.');

        void this.loop(intervalMs);
    }

    public stop() {
        this.isRunning = false;
    }

    private async loop(intervalMs: number) {
        while (this.isRunning) {
            try {
                await this.runConsolidationCycle();
            } catch (error: any) {
                if (error.message?.includes('MVCC Conflict')) {
                    console.warn('[System 3] MVCC Conflict detected. State changed during analysis. Retrying next cycle...');
                } else {
                    console.error('[System 3] Cycle error:', error);
                }
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    }

    public async runConsolidationCycle(): Promise<void> {
        console.log('[System 3] Scanning for dream consolidation candidates...');

        const { entries, generation } = await this.engine.scanMemories(200);

        const candidates = entries.filter(e =>
            e.class === BlockClass.B &&
            !e.tags.includes('sys:processed:dream')
        );

        if (candidates.length < 5) {
            console.log(`[System 3] Only ${candidates.length} candidates found. Skipping cycle.`);
            return;
        }

        const batch = candidates.slice(-20);
        const batchIds = batch.map(b => b.id);

        console.log(`[System 3] Consolidating ${batch.length} memories into a Dream Summary...`);

        const summaryContent = await this.synthesizeDream(batch);

        const plan: CompactionPlan = {
            expectedGeneration: generation,
            supersedeIds: batchIds,
            additions: [
                {
                    content: summaryContent,
                    class: BlockClass.S,
                    tags: ['sys:dream:summary', 'consolidated', ...this.extractCommonTags(batch)]
                }
            ]
        };

        await this.engine.commitCompaction(plan);
        console.log(`[System 3] Dream Consolidation committed. ${batch.length} blocks superseded.`);
    }

    private async synthesizeDream(blocks: MemoryBlockDTO[]): Promise<string> {
        const dateRange = `${new Date(blocks[blocks.length - 1].timestamp).toLocaleDateString()} to ${new Date(blocks[0].timestamp).toLocaleDateString()}`;
        return `[Dream Summary ${dateRange}] Captured patterns from ${blocks.length} events. Primary focus: ${blocks[0].tags.join(', ')}.`;
    }

    private extractCommonTags(blocks: MemoryBlockDTO[]): string[] {
        const counts = new Map<string, number>();
        for (const block of blocks) {
            for (const tag of block.tags) {
                counts.set(tag, (counts.get(tag) || 0) + 1);
            }
        }
        return Array.from(counts.entries())
            .filter(([_, count]) => count > blocks.length / 2)
            .map(([tag]) => tag);
    }
}
