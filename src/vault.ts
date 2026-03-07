import * as fs from 'fs/promises';
import * as path from 'path';
import { ShadowIndex, BlockClass, BlockMultipliers, IndexEntry } from './types';

export class AsyncMutex {
    private queue: Promise<void> = Promise.resolve();

    async run<T>(callback: () => Promise<T>): Promise<T> {
        const next = this.queue.then(() => callback());
        this.queue = next.then(() => { }, () => { }); // Catch both success and failure to proceed
        return next;
    }
}

export class VaultManager {
    private baseDir: string;
    private pendingPath: string;
    private vaultPath: string;
    private indexPath: string;
    private indexLogPath: string;
    private memoryIndex: ShadowIndex | null = null;
    private writeMutex = new AsyncMutex();

    constructor(baseDir: string) {
        this.baseDir = baseDir;
        this.pendingPath = path.join(baseDir, 'pending.txt');
        this.vaultPath = path.join(baseDir, 'vault.txt');
        this.indexPath = path.join(baseDir, 'shadow_meta.json');
        this.indexLogPath = path.join(baseDir, 'index_log.jsonl');
    }

    /**
     * Ensure all necessary files and directories exist.
     */
    async init(): Promise<void> {
        await fs.mkdir(this.baseDir, { recursive: true });

        for (const p of [this.pendingPath, this.vaultPath, this.indexLogPath]) {
            try {
                await fs.access(p);
            } catch {
                await fs.writeFile(p, '', 'utf-8');
            }
        }

        try {
            await fs.access(this.indexPath);
        } catch {
            const initialMeta = {
                version: '2.0.0',
                last_weaved_at: new Date().toISOString(),
                total_blocks: 0,
            };
            await fs.writeFile(this.indexPath, JSON.stringify(initialMeta, null, 2));
        }

        // Warm up the index cache
        await this.readIndex();
    }

    /**
     * Append a new log entry and its index metadata (Append-Only).
     */
    async appendPending(content: string, blockClass: BlockClass, tags: string[] = []): Promise<string> {
        return this.writeMutex.run(async () => {
            const timestamp = Date.now();
            const blockId = `block_${timestamp}_${Math.random().toString(36).substring(2, 7)}`;

            let offset_start = 0;
            try {
                const stats = await fs.stat(this.pendingPath);
                offset_start = stats.size;
            } catch (error: any) {
                // Handle race condition: Weaver just renamed pending.txt to processing.tmp
                if (error.code !== 'ENOENT') throw error;
            }

            const entry = `[${blockId}] [${blockClass}] [${new Date(timestamp).toISOString()}]\n${content}\n---\n`;
            const buffer = Buffer.from(entry, 'utf-8');
            await fs.appendFile(this.pendingPath, buffer);

            const offset_end = offset_start + buffer.length;

            const indexEntry: IndexEntry = {
                id: blockId,
                class: blockClass,
                multiplier: BlockMultipliers[blockClass],
                sourceFile: 'pending',
                offset_start,
                offset_end,
                timestamp,
                tags
            };

            // Requirement A: Scalable Index Logic (JSONL Append)
            await fs.appendFile(this.indexLogPath, JSON.stringify(indexEntry) + '\n', 'utf-8');

            // Update In-Memory Cache
            if (this.memoryIndex) {
                this.internalUpdateCache(this.memoryIndex, indexEntry);
                this.memoryIndex.system_meta.total_blocks++;
            }

            return blockId;
        });
    }

    /**
     * Replays the JSONL to build a Map-based index in memory.
     */
    async readIndex(): Promise<ShadowIndex> {
        if (this.memoryIndex) return this.memoryIndex;

        const metaData = await fs.readFile(this.indexPath, 'utf-8');
        const meta = JSON.parse(metaData);

        const index: ShadowIndex = {
            system_meta: meta,
            tag_graph: new Map(),
            index_table: new Map()
        };

        const logContent = await fs.readFile(this.indexLogPath, 'utf-8');
        const lines = logContent.split('\n').filter(l => l.trim());

        for (const line of lines) {
            try {
                const entry: IndexEntry = JSON.parse(line);

                // Compatibility for legacy entries
                if (!entry.sourceFile) {
                    entry.sourceFile = entry.id.startsWith('woven_') ? 'vault' : 'pending';
                }

                this.internalUpdateCache(index, entry);
            } catch (e) {
                // Ignore parse errors for individual lines
            }
        }

        this.memoryIndex = index;
        return index;
    }

    async clearCache() {
        this.memoryIndex = null;
    }

    async deleteMemory(id: string): Promise<void> {
        return this.writeMutex.run(async () => {
            const index = await this.readIndex();
            const entry = index.index_table.get(id);
            if (!entry) return;

            // 1. Remove from in-memory cache
            index.index_table.delete(id);
            for (const tag of entry.tags) {
                const normalizedTag = tag.toLowerCase();
                index.tag_graph.get(normalizedTag)?.delete(id);
            }
            index.system_meta.total_blocks--;

            // 2. Rewrite index_log.jsonl to physically remove the reference
            const logContent = await fs.readFile(this.indexLogPath, 'utf-8');
            const lines = logContent.split('\n').filter(l => l.trim());
            const newLines = lines.filter(line => {
                try {
                    const e: IndexEntry = JSON.parse(line);
                    return e.id !== id;
                } catch { return true; }
            });
            await fs.writeFile(this.indexLogPath, newLines.join('\n') + (newLines.length > 0 ? '\n' : ''), 'utf-8');

            // 3. Physical removal from vault.txt/pending.txt is skipped to preserve O(1) performance.
            // Since the index reference is gone, the data is unreachable by the retriever.
        });
    }

    private internalUpdateCache(index: ShadowIndex, entry: IndexEntry) {
        index.index_table.set(entry.id, entry);
        for (const tag of entry.tags) {
            const normalizedTag = tag.toLowerCase();
            if (!index.tag_graph.has(normalizedTag)) {
                index.tag_graph.set(normalizedTag, new Set());
            }
            index.tag_graph.get(normalizedTag)!.add(entry.id);
        }
    }
}
