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
    private isDisposed = false;
    private static readonly SCAN_CURSOR_PREFIX = 'v1';

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
                generation: 0,
            };
            await fs.writeFile(this.indexPath, JSON.stringify(initialMeta, null, 2));
        }

        // Warm up the index cache
        await this.readIndex();
    }

    /**
     * Append a new log entry and its index metadata (Append-Only).
     */
    async appendPending(content: string, blockClass: BlockClass, tags: string[] = [], signature?: string): Promise<string> {
        this.assertNotDisposed();
        return this.writeMutex.run(async () => {
            const index = await this.readIndex();
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

            const sigTag = signature ? ` [SIG:${signature}]` : '';
            const entry = `[${blockId}] [${blockClass}] [${new Date(timestamp).toISOString()}]${sigTag}\n${content}\n---\n`;
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
                tags,
                signature
            };

            // Requirement A: Scalable Index Logic (JSONL Append)
            await fs.appendFile(this.indexLogPath, JSON.stringify(indexEntry) + '\n', 'utf-8');

            // Update in-memory cache and bump generation for strict MVCC.
            this.internalUpdateCache(index, indexEntry);
            index.system_meta.total_blocks = index.index_table.size;
            this.bumpGeneration(index);
            await this.persistSystemMeta(index);

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

        if (typeof meta.generation !== 'number') {
            meta.generation = 0;
        }

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

    /**
     * Objective 1: Atomic Handshake/Event Callback
     * Drops pending index entries that were consolidated and rebuilds the state.
     * @param ignoreBeforeTs - All pending entries before this timestamp are considered consolidated and will be dropped.
     */
    async rebuildIndexAfterWeaving(ignoreBeforeTs: number): Promise<void> {
        this.assertNotDisposed();
        return this.writeMutex.run(async () => {
            // 1. Clear memory cache
            this.memoryIndex = null;

            // 2. Read and filter the index log
            const logContent = await fs.readFile(this.indexLogPath, 'utf-8');
            const lines = logContent.split('\n').filter(l => l.trim());

            const filteredEntries = lines.filter(line => {
                try {
                    const entry: IndexEntry = JSON.parse(line);
                    // Keep all vault entries
                    if (entry.sourceFile === 'vault') return true;
                    // Only keep pending entries that were added AFTER the consolidation started
                    return entry.sourceFile === 'pending' && entry.timestamp >= ignoreBeforeTs;
                } catch { return false; }
            });

            // 3. Atomically overwrite the index log
            await fs.writeFile(this.indexLogPath, filteredEntries.join('\n') + (filteredEntries.length > 0 ? '\n' : ''), 'utf-8');

            // 4. Update the manifest (shadow_meta.json)
            const metaData = await fs.readFile(this.indexPath, 'utf-8');
            const meta = JSON.parse(metaData);
            meta.last_weaved_at = new Date().toISOString();
            meta.generation = (meta.generation ?? 0) + 1;
            await fs.writeFile(this.indexPath, JSON.stringify(meta, null, 2));

            // 5. Force reload and persist accurate totals
            const rebuilt = await this.readIndex();
            rebuilt.system_meta.total_blocks = rebuilt.index_table.size;
            await this.persistSystemMeta(rebuilt);
            console.log(`[Vault] Index rebuilt. Dropped entries before ${new Date(ignoreBeforeTs).toISOString()}.`);
        });
    }

    /**
     * Alias for compatibility with MVCC write-operation naming.
     */
    async rebuildIndex(ignoreBeforeTs: number): Promise<void> {
        return this.rebuildIndexAfterWeaving(ignoreBeforeTs);
    }


    /**
     * Finds a memory by its ID.
     */
    async getMemoryById(id: string): Promise<IndexEntry | undefined> {
        const index = await this.readIndex();
        return index.index_table.get(id);
    }

    /**
     * Atomically updates the tags of an existing memory.
     */
    async updateMemoryTags(id: string, newTags: string[]): Promise<void> {
        this.assertNotDisposed();
        return this.writeMutex.run(async () => {
            const index = await this.readIndex();
            const entry = index.index_table.get(id);
            if (!entry) throw new Error(`Memory with ID ${id} not found.`);

            // 1. Update in-memory Tag Graph
            for (const tag of entry.tags) {
                const normalizedTag = tag.toLowerCase();
                index.tag_graph.get(normalizedTag)?.delete(id);
            }

            // Update the entry reference (it's the same object in index_table)
            entry.tags = [...new Set(newTags)];

            // Re-inject into Tag Graph
            for (const tag of entry.tags) {
                const normalizedTag = tag.toLowerCase();
                if (!index.tag_graph.has(normalizedTag)) {
                    index.tag_graph.set(normalizedTag, new Set());
                }
                index.tag_graph.get(normalizedTag)!.add(id);
            }

            // 2. Rewrite index_log.jsonl
            const logContent = await fs.readFile(this.indexLogPath, 'utf-8');
            const lines = logContent.split('\n').filter(l => l.trim());
            const newLines = lines.map(line => {
                try {
                    const e: IndexEntry = JSON.parse(line);
                    if (e.id === id) {
                        e.tags = entry.tags;
                        return JSON.stringify(e);
                    }
                    return line;
                } catch { return line; }
            });
            await fs.writeFile(this.indexLogPath, newLines.join('\n') + (newLines.length > 0 ? '\n' : ''), 'utf-8');

            index.system_meta.total_blocks = index.index_table.size;
            this.bumpGeneration(index);
            await this.persistSystemMeta(index);
        });
    }

    async deleteMemory(id: string): Promise<void> {
        this.assertNotDisposed();
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
            index.system_meta.total_blocks = index.index_table.size;

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
            this.bumpGeneration(index);
            await this.persistSystemMeta(index);
        });
    }

    private internalUpdateCache(index: ShadowIndex, entry: IndexEntry) {
        index.index_table.set(entry.id, entry);
        if (entry.isSuperseded) return; // Don't index tags for superseded blocks

        for (const tag of entry.tags) {
            const normalizedTag = tag.toLowerCase();
            if (!index.tag_graph.has(normalizedTag)) {
                index.tag_graph.set(normalizedTag, new Set());
            }
            index.tag_graph.get(normalizedTag)!.add(entry.id);
        }
    }

    /**
     * Permanently closes the vault, rejecting all future write operations.
     * Called by SMSQLEngine.dispose() after the synthesizer has been stopped and
     * the semantic worker has been terminated.
     */
    public dispose(): void {
        this.isDisposed = true;
        this.memoryIndex = null; // Release the in-memory index to GC
    }

    /**
     * Throws synchronously if the vault has been disposed.
     * Called as the FIRST statement in every public write method, before the
     * writeMutex is even queued, so teardown never silently swallows a write.
     */
    private assertNotDisposed(): void {
        if (this.isDisposed) {
            throw new Error(
                '[SMSQL] VaultManager has been disposed. The engine has been shut down; no new writes are accepted.'
            );
        }
    }

    /**
     * P2 MVCC: Returns the current state version.
     */
    public getGeneration(): number {
        return this.memoryIndex?.system_meta.generation ?? 0;
    }

    /**
     * Returns the total recorded blocks in the active index.
     */
    public getTotalBlocks(): number {
        return this.memoryIndex?.system_meta.total_blocks ?? 0;
    }

    /**
     * P2 MVCC: Paginated scan of the index without locking.
     */
    public async scanMemories(limit: number = 100, cursor?: string, includeInactive: boolean = false): Promise<{ entries: IndexEntry[], nextCursor?: string, generation: number }> {
        const index = await this.readIndex();
        const generation = index.system_meta.generation ?? 0;
        const normalizedLimit = Math.max(1, limit);

        let snapshot = Array.from(index.index_table.values());
        if (!includeInactive) {
            snapshot = snapshot.filter(e => !e.isSuperseded);
        }

        // Deterministic snapshot ordering: timestamp DESC, id DESC.
        snapshot.sort(VaultManager.compareEntriesDesc);

        let startIndex = 0;
        if (cursor) {
            const decoded = this.decodeScanCursor(cursor);
            if (decoded) {
                if (decoded.generation !== generation) {
                    throw new Error(`MVCC Conflict: scan cursor generation ${decoded.generation} is stale; current generation is ${generation}.`);
                }

                const cursorIndex = snapshot.findIndex(e => e.id === decoded.id && e.timestamp === decoded.timestamp);
                if (cursorIndex >= 0) {
                    startIndex = cursorIndex + 1;
                } else {
                    const cursorKey = { id: decoded.id, timestamp: decoded.timestamp };
                    const firstAfterCursor = snapshot.findIndex(e => VaultManager.compareEntriesDesc(e, cursorKey) > 0);
                    startIndex = firstAfterCursor >= 0 ? firstAfterCursor : snapshot.length;
                }
            } else {
                // Backward compatibility for legacy cursor format (id only).
                const legacyIndex = snapshot.findIndex(e => e.id === cursor);
                startIndex = legacyIndex >= 0 ? legacyIndex + 1 : snapshot.length;
            }
        }

        const slice = snapshot.slice(startIndex, startIndex + normalizedLimit);
        const hasMore = (startIndex + slice.length) < snapshot.length;
        const nextCursor = hasMore && slice.length > 0
            ? this.encodeScanCursor(slice[slice.length - 1], generation)
            : undefined;

        return { entries: slice, nextCursor, generation };
    }

    /**
     * P2 MVCC: Atomic batch mutation of the database state.
     */
    public async commitCompaction(plan: import('./types').CompactionPlan): Promise<void> {
        this.assertNotDisposed();
        return this.writeMutex.run(async () => {
            const index = await this.readIndex();

            // 1. MVCC Validation
            if (index.system_meta.generation !== plan.expectedGeneration) {
                throw new Error(`MVCC Conflict: State is at generation ${index.system_meta.generation}, but compaction expected ${plan.expectedGeneration}`);
            }

            // 2. Mark Superseded (Mutations)
            for (const id of plan.supersedeIds) {
                const entry = index.index_table.get(id);
                if (entry) {
                    entry.isSuperseded = true;
                    if (!entry.tags.includes('sys:state:superseded')) {
                        entry.tags.push('sys:state:superseded');
                    }
                    // Remove from tag graph to prevent retrieval
                    for (const tag of entry.tags) {
                        index.tag_graph.get(tag.toLowerCase())?.delete(id);
                    }
                    // Persist state change to log
                    await fs.appendFile(this.indexLogPath, JSON.stringify(entry) + '\n', 'utf-8');
                }
            }

            // 3. Process Additions
            for (const add of plan.additions) {
                const timestamp = Date.now();
                const blockId = `compact_${timestamp}_${Math.random().toString(36).substring(2, 7)}`;

                const stats = await fs.stat(this.vaultPath);
                const offset_start = stats.size;

                const sigTag = add.signature ? ` [SIG:${add.signature}]` : '';
                const entryContent = `[${blockId}] [${add.class}] [${new Date(timestamp).toISOString()}]${sigTag}\n${add.content}\n---\n`;
                const buffer = Buffer.from(entryContent, 'utf-8');

                await fs.appendFile(this.vaultPath, buffer);
                const offset_end = offset_start + buffer.length;

                const indexEntry: IndexEntry = {
                    id: blockId,
                    class: add.class,
                    multiplier: BlockMultipliers[add.class],
                    sourceFile: 'vault',
                    offset_start,
                    offset_end,
                    timestamp,
                    tags: add.tags,
                    signature: add.signature
                };

                this.internalUpdateCache(index, indexEntry);
                await fs.appendFile(this.indexLogPath, JSON.stringify(indexEntry) + '\n', 'utf-8');
            }

            // 4. Finalize
            this.bumpGeneration(index);
            index.system_meta.total_blocks = index.index_table.size;
            await this.persistSystemMeta(index);

            console.log(`[Vault] Compaction committed. Generation: ${index.system_meta.generation}`);
        });
    }

    private async persistSystemMeta(index: ShadowIndex): Promise<void> {
        await fs.writeFile(this.indexPath, JSON.stringify(index.system_meta, null, 2));
    }

    private bumpGeneration(index: ShadowIndex): void {
        index.system_meta.generation = (index.system_meta.generation ?? 0) + 1;
    }

    private static compareEntriesDesc(a: Pick<IndexEntry, 'timestamp' | 'id'>, b: Pick<IndexEntry, 'timestamp' | 'id'>): number {
        if (a.timestamp !== b.timestamp) {
            return b.timestamp - a.timestamp;
        }
        return b.id.localeCompare(a.id);
    }

    private encodeScanCursor(entry: Pick<IndexEntry, 'id' | 'timestamp'>, generation: number): string {
        return `${VaultManager.SCAN_CURSOR_PREFIX}:${generation}:${entry.timestamp}:${entry.id}`;
    }

    private decodeScanCursor(cursor: string): { generation: number; timestamp: number; id: string } | null {
        const parts = cursor.split(':');
        if (parts.length < 4 || parts[0] !== VaultManager.SCAN_CURSOR_PREFIX) {
            return null;
        }

        const generation = Number(parts[1]);
        const timestamp = Number(parts[2]);
        const id = parts.slice(3).join(':');
        if (!Number.isFinite(generation) || !Number.isFinite(timestamp) || !id) {
            return null;
        }

        return { generation, timestamp, id };
    }
}
