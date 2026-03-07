import * as path from 'path';
import * as fs from 'fs/promises';
import OpenAI from 'openai';
import { VaultManager } from './vault';
import { Retriever, RetrievalResult } from './retriever';
import { Weaver } from './weaver';
import { BlockClass, SMSQLConfig } from './types';

/**
 * Standard Library Engine: Domain-agnostic high-performance RAG storage.
 */
export class SMSQLEngine {
    private vaultManager: VaultManager;
    private retriever: Retriever;
    private weaver: Weaver;
    private baseDir: string;

    constructor(baseDir: string, config: SMSQLConfig) {
        this.baseDir = baseDir;
        const vaultPath = path.join(baseDir, 'vault.txt');
        const pendingPath = path.join(baseDir, 'pending.txt');

        this.vaultManager = new VaultManager(baseDir);
        this.retriever = new Retriever(this.vaultManager, vaultPath, pendingPath);
        this.weaver = new Weaver(this.vaultManager, config.llmClient, config);
    }

    /**
     * Initializes the engine, ensuring storage directories and index meta exist.
     */
    async init(): Promise<void> {
        await this.vaultManager.init();
    }

    /**
     * System 1: Ultra-fast retrieval from the fuzzy index and physical files.
     */
    async searchMemories(query: string): Promise<RetrievalResult> {
        return this.retriever.fastRetrieve(query);
    }

    /**
     * Advanced retrieval with time filtration and pagination.
     */
    async searchMemoriesAdvanced(params: { query?: string; fromTs?: number; toTs?: number; limit?: number; }): Promise<RetrievalResult> {
        return this.retriever.advancedSearch(params);
    }

    /**
     * Chronological fetch for sliding context windows.
     */
    async getMemoriesByTimeRange(fromTs: number, toTs: number, limit?: number): Promise<RetrievalResult> {
        return this.retriever.advancedSearch({ fromTs, toTs, limit });
    }

    /**
     * Physical removal of a memory record from the index and logic.
     */
    async deleteMemory(id: string): Promise<void> {
        await this.vaultManager.deleteMemory(id);
    }

    /**
     * System 1: O(1) appending to the memory buffer. Thread-safe via AsyncMutex.
     */
    async saveMemory(content: string, blockClass: BlockClass = BlockClass.B, tags: string[] = []): Promise<string> {
        return this.vaultManager.appendPending(content, blockClass, tags);
    }

    /**
     * System 2: Triggers the LLM-driven categorization and consolidation of 
     * the pending memory buffer into the long-term vault.
     */
    async consolidate(): Promise<void> {
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
}
