import * as path from 'path';
import * as fs from 'fs/promises';
import { VaultManager } from './vault';
import { Retriever, RetrievalResult } from './retriever';
import { Weaver } from './weaver';
import { BlockClass, SMSQLConfig, MemoryType, MemoryBlockDTO, CompactionPlan } from './types';
import { SemanticIntuition } from './engine/SemanticIntuition';
import { MemorySynthesizer } from './engine/MemorySynthesizer';

/**
 * Standard Library Engine: Domain-agnostic high-performance RAG storage.
 */
export class SMSQLEngine {
    private vaultManager: VaultManager;
    private retriever: Retriever;
    private weaver: Weaver;
    private semanticIntuition: SemanticIntuition;
    private memorySynthesizer: MemorySynthesizer | null = null;
    private isDisposed = false;
    public readonly config: SMSQLConfig;
    private baseDir: string;

    constructor(baseDir: string, config: SMSQLConfig) {
        this.baseDir = baseDir;
        const vaultPath = path.join(baseDir, 'vault.txt');
        const pendingPath = path.join(baseDir, 'pending.txt');

        this.config = config;
        this.vaultManager = new VaultManager(baseDir);
        this.semanticIntuition = new SemanticIntuition(config.semanticEnabled || false);
        this.retriever = new Retriever(this.vaultManager, vaultPath, pendingPath, this.semanticIntuition);
        this.weaver = new Weaver(this.vaultManager, config.llmClient, config, this.semanticIntuition);
    }

    /**
     * Initializes the engine, ensuring storage directories and index meta exist.
     */
    async init(): Promise<void> {
        await this.vaultManager.init();
        if (this.semanticIntuition.isEnabled()) {
            await this.semanticIntuition.init().catch(e => {
                console.error(`[SMSQL] Semantic Intuition init failed:`, e);
            });
        }
    }

    /**
     * System 1: Ultra-fast retrieval from the fuzzy index and physical files.
     */
    async searchMemories(query: string, tags?: string[]): Promise<RetrievalResult> {
        const result = await this.retriever.fastRetrieve(query, tags);
        return result;
    }

    /**
     * Advanced retrieval with time filtration and pagination.
     * Returns a flat array of DTOs for direct Agent consumption.
     */
    async searchMemoriesAdvanced(params: { query?: string; fromTs?: number; toTs?: number; limit?: number; tags?: string[]; }): Promise<MemoryBlockDTO[]> {
        const result = await this.retriever.advancedSearch(params);

        if (result.blocks.length === 0 && params.query && this.semanticIntuition.isEnabled()) {
            try {
                const querySig = await this.semanticIntuition.encode(params.query);
                const semanticHits = await this.retriever.semanticRetrieve(querySig, params.tags);
                if (semanticHits.length > 0) {
                    const index = await this.vaultManager.readIndex();
                    const materialized = await this.retriever.materialize(semanticHits, index);
                    return materialized;
                }
            } catch (e) {
                console.warn(`[SMSQL] Semantic fallback failed:`, e);
            }
        }

        return result.blocks;
    }

    /**
     * Chronological fetch for sliding context windows.
     */
    async getMemoriesByTimeRange(fromTs: number, toTs: number, limit?: number): Promise<MemoryBlockDTO[]> {
        const result = await this.retriever.advancedSearch({ fromTs, toTs, limit });
        return result.blocks;
    }

    /**
     * Physical removal of a memory record from the index and logic.
     */
    async deleteMemory(id: string): Promise<void> {
        await this.vaultManager.deleteMemory(id);
    }

    /**
     * Updates the tags of an existing memory.
     */
    async updateMemoryTags(id: string, tags: string[]): Promise<void> {
        await this.vaultManager.updateMemoryTags(id, tags);
    }

    /**
     * Returns the metadata of a memory by its ID.
     */
    async getMemoryMetadata(id: string) {
        return this.vaultManager.getMemoryById(id);
    }

    /**
     * System 1: O(1) appending to the memory buffer. Thread-safe via AsyncMutex.
     * Uses semantic types to map to internal BlockClasses.
     */
    async saveMemory(content: string, type: MemoryType = 'short-term', tags: string[] = []): Promise<string> {
        const typeMap: Record<MemoryType, BlockClass> = {
            'core': BlockClass.S,
            'preference': BlockClass.E,
            'short-term': BlockClass.B
        };

        const internalClass = typeMap[type] || BlockClass.B;

        let signatureBase64: string | undefined;
        if (this.semanticIntuition.isEnabled()) {
            try {
                const sig = await this.semanticIntuition.encode(content);
                signatureBase64 = Buffer.from(sig).toString('base64');
            } catch (e) {
                console.warn(`[SMSQL] Failed to encode signature:`, e);
            }
        }

        return this.vaultManager.appendPending(content, internalClass, tags, signatureBase64);
    }

    /**
     * System 2: Triggers the LLM-driven categorization and consolidation of
     * the pending memory buffer into the long-term vault.
     */
    async consolidate(): Promise<void> {
        if (!this.config.baseSystemPrompt) {
            throw new Error('[SMSQL] Consolidation requires a baseSystemPrompt in config.');
        }
        await this.weaver.weavePendingLogs(this.baseDir);
    }

    /**
     * Returns the current status of the pending buffer.
     * Useful for checking if System 2 weaving is necessary.
     */
    async getPendingStatus(thresholdBytes: number = 1000): Promise<{ size: number; shouldConsolidate: boolean }> {
        const pendingPath = path.join(this.baseDir, 'pending.txt');
        try {
            const stats = await fs.stat(pendingPath);
            return {
                size: stats.size,
                shouldConsolidate: stats.size > thresholdBytes
            };
        } catch (e: any) {
            if (e.code === 'ENOENT') return { size: 0, shouldConsolidate: false };
            throw e;
        }
    }

    /**
     * P2 MVCC: Returns the current state version for atomic mutations.
     */
    getGeneration(): number {
        return this.vaultManager.getGeneration();
    }

    /**
     * Returns the total number of active blocks in the vault.
     */
    getTotalBlocks(): number {
        return this.vaultManager.getTotalBlocks();
    }

    /**
     * Returns a summary of the current vault status, including pending data.
     */
    async getVaultSummary() {
        return {
            totalBlocks: this.getTotalBlocks(),
            generation: this.getGeneration(),
            pending: await this.getPendingStatus()
        };
    }

    /**
     * P2 MVCC: Materialized scan for background maintenance.
     */
    async scanMemories(limit: number, cursor?: string, includeInactive: boolean = false): Promise<{ entries: MemoryBlockDTO[]; nextCursor?: string; generation: number }> {
        return this.retriever.materializedScan(limit, cursor, includeInactive);
    }

    /**
     * P2 MVCC: Explicit index rebuild operation.
     */
    async rebuildIndex(ignoreBeforeTs: number): Promise<void> {
        return this.vaultManager.rebuildIndex(ignoreBeforeTs);
    }

    /**
     * P2 MVCC: Commits a batch of mutations (Additions/Supersessions).
     */
    async commitCompaction(plan: CompactionPlan): Promise<void> {
        return this.vaultManager.commitCompaction(plan);
    }

    startSynthesizer(intervalMs: number): void {
        if (!this.memorySynthesizer) {
            this.memorySynthesizer = new MemorySynthesizer(this);
        }
        this.memorySynthesizer.start(intervalMs);
    }

    stopSynthesizer(): Promise<void> {
        return this.memorySynthesizer?.stop() ?? Promise.resolve();
    }

    /**
     * Standard library teardown — call this before destroying the engine instance or
     * exiting the process. Process exit itself remains the application's responsibility.
     *
     * Shutdown sequence (order is strict):
     *   1. Set disposed flag — prevents new operations from starting.
     *   2. Abort in-flight synthesizer cycle and await its `finally` block.
     *   3. Terminate the SemanticIntuition WASM worker thread (if active).
     *   4. Lock the VaultManager — all subsequent write calls throw synchronously.
     */
    async dispose(): Promise<void> {
        if (this.isDisposed) return;
        this.isDisposed = true;

        // Phase 2: stop synthesizer and wait for the in-flight LLM cycle to fully exit
        await this.stopSynthesizer();

        // Phase 3: terminate the background ONNX/WASM worker thread
        if (this.semanticIntuition.isEnabled()) {
            await this.semanticIntuition.terminate();
        }

        // Phase 4: lock the vault — rejects all future appendPending / commitCompaction calls
        this.vaultManager.dispose();

        console.log('[SMSQL] Engine disposed. All subsystems offline.');
    }
}
