import * as fs from 'fs';
import { VaultManager } from './vault';
import { ShadowIndex, BlockClass, IndexEntry, MemoryBlockDTO } from './types';
import { SemanticIntuition } from './engine/SemanticIntuition';

export interface RetrievalTraceEntry {
    keyword: string;
    matchedTag: string;
    blockId: string;
    weightScore: number;
    timestamp: number;
    distance: number;
}

export interface RetrievalResult {
    blocks: MemoryBlockDTO[];
    timings: {
        indexSearch: number;
        sorting: number;
        vaultSlicing: number;
        total: number;
    };
}

export class Retriever {
    private vaultManager: VaultManager;
    private vaultPath: string;
    private pendingPath: string;
    private stopWords: Set<string>;
    private semanticIntuition?: SemanticIntuition;

    constructor(vaultManager: VaultManager, vaultPath: string, pendingPath: string, semanticIntuition?: SemanticIntuition) {
        this.vaultManager = vaultManager;
        this.vaultPath = vaultPath;
        this.pendingPath = pendingPath;
        this.semanticIntuition = semanticIntuition;
        this.stopWords = new Set([
            'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was',
            'this', 'that', 'with', 'from', 'have', 'has', 'had', 'they', 'our',
            'what', 'when', 'where', 'why', 'how', 'will', 'would', 'could'
        ]);
    }

    private levenshteinDistance(a: string, b: string): number {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;

        const matrix: number[][] = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    }

    private stemWord(word: string): string {
        let stemmed = word.toLowerCase();
        if (stemmed.endsWith('ies') && stemmed.length > 4) return stemmed.substring(0, stemmed.length - 3) + 'y';
        if (stemmed.endsWith('es') && stemmed.length > 3) return stemmed.substring(0, stemmed.length - 2);
        if (stemmed.endsWith('s') && stemmed.length > 3 && !stemmed.endsWith('ss')) return stemmed.substring(0, stemmed.length - 1);
        return stemmed;
    }

    private extractKeywords(input: string): string[] {
        return input.toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, '')
            .split(/\s+/)
            .filter(w => w.length >= 2 && !this.stopWords.has(w))
            .map(w => this.stemWord(w));
    }

    private normalizeStoredContent(rawContent: string): string {
        const lines = rawContent.split('\n');
        const body = lines.slice(1).join('\n').replace(/\n---\s*$/, '').trim();
        return body || rawContent.trim();
    }

    /**
     * Executes System 1: Lightweight fuzzy search through the indexed tag graph.
     */
    async fastRetrieve(userInput: string, tags?: string[]): Promise<RetrievalResult> {
        const t0 = performance.now();
        const index = await this.vaultManager.readIndex();

        const keywords = this.extractKeywords(userInput);
        const hitMap = new Map<string, { entry: RetrievalTraceEntry, hitCount: number }>();

        const t1 = performance.now();
        for (const queryKw of keywords) {
            const maxDistance = queryKw.length > 6 ? 2 : 1;

            for (const [tag, blockIds] of index.tag_graph) {
                let distance = 0;
                let isMatch = tag.includes(queryKw);

                if (!isMatch) {
                    const tagParts = tag.replace(/_/g, ' ').split(' ');
                    for (const part of tagParts) {
                        const stemmedPart = this.stemWord(part);
                        const pDist = this.levenshteinDistance(queryKw, stemmedPart);
                        if (pDist <= maxDistance) {
                            isMatch = true;
                            distance = pDist;
                            break;
                        }
                    }
                }

                if (isMatch) {
                    for (const id of blockIds) {
                        const meta = index.index_table.get(id);
                        if (meta) {
                            if (meta.isSuperseded) continue;
                            if (tags && !tags.every(t => meta.tags.includes(t))) {
                                continue;
                            }

                            const existing = hitMap.get(id);
                            if (existing) {
                                existing.hitCount++;
                                if (distance < existing.entry.distance) {
                                    existing.entry.distance = distance;
                                    existing.entry.keyword = queryKw;
                                    existing.entry.matchedTag = tag;
                                }
                            } else {
                                hitMap.set(id, {
                                    hitCount: 1,
                                    entry: {
                                        keyword: queryKw,
                                        matchedTag: tag,
                                        blockId: id,
                                        weightScore: meta.multiplier,
                                        timestamp: meta.timestamp,
                                        distance: distance
                                    }
                                });
                            }
                        }
                    }
                }
            }
        }
        const t2 = performance.now();

        let sortedBlocks = Array.from(hitMap.values()).map(h => {
            const hitMultiplier = 1 + (h.hitCount - 1) * 0.5;
            const updatedScore = h.entry.weightScore * hitMultiplier;
            return { ...h.entry, weightScore: updatedScore };
        }).sort((a, b) => {
            const rawScoreA = a.weightScore * (1 + (a.timestamp / Date.now()));
            const accScoreA = rawScoreA - (a.distance * 0.5);
            const rawScoreB = b.weightScore * (1 + (b.timestamp / Date.now()));
            const accScoreB = rawScoreB - (b.distance * 0.5);
            return accScoreB - accScoreA;
        }).slice(0, 10);

        if (sortedBlocks.length === 0) {
            const sBlocks = Array.from(index.index_table.values())
                .filter(m => {
                    if (m.class !== BlockClass.S || m.isSuperseded) return false;
                    if (tags && !tags.every(t => m.tags.includes(t))) return false;
                    return true;
                })
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 2);

            for (const meta of sBlocks) {
                sortedBlocks.push({
                    keyword: '[FALLBACK]', matchedTag: 'Priority_Block', blockId: meta.id,
                    weightScore: meta.multiplier, timestamp: meta.timestamp, distance: 0
                });
            }
        }
        const t3 = performance.now();
        const blocks = await this.materialize(sortedBlocks, index);
        const t4 = performance.now();

        return {
            blocks,
            timings: {
                indexSearch: parseFloat((t2 - t1).toFixed(4)),
                sorting: parseFloat((t3 - t2).toFixed(4)),
                vaultSlicing: parseFloat((t4 - t3).toFixed(4)),
                total: parseFloat((t4 - t0).toFixed(4))
            }
        };
    }

    /**
     * Executes System 1-B: Rapid Hamming scan across precomputed binary signatures.
     */
    public async semanticRetrieve(querySignature: Uint8Array, tags?: string[]): Promise<RetrievalTraceEntry[]> {
        const index = await this.vaultManager.readIndex();

        const candidates: { id: string, signature: Uint8Array }[] = [];
        for (const [id, meta] of index.index_table) {
            if (!meta.signature || meta.isSuperseded) continue;
            if (tags && !tags.every(t => meta.tags.includes(t))) continue;
            candidates.push({ id, signature: Uint8Array.from(Buffer.from(meta.signature, 'base64')) });
        }

        if (candidates.length === 0 || !this.semanticIntuition) return [];

        const workerHits = await this.semanticIntuition.scan(querySignature, candidates);

        return workerHits.map(hit => {
            const meta = index.index_table.get(hit.id)!;
            return {
                keyword: '[SEMANTIC_OFFLOADED]',
                matchedTag: 'Semantic_Intuition',
                blockId: hit.id,
                weightScore: meta.multiplier,
                timestamp: meta.timestamp,
                distance: hit.distance
            };
        });
    }

    public async materialize(blocks: RetrievalTraceEntry[], index: ShadowIndex): Promise<MemoryBlockDTO[]> {
        const results: MemoryBlockDTO[] = [];
        if (blocks.length === 0) {
            return results;
        }

        const openFiles: Map<string, number> = new Map();
        try {
            for (const block of blocks) {
                const meta = index.index_table.get(block.blockId);
                if (!meta) continue;

                const filePath = meta.sourceFile === 'vault' ? this.vaultPath : this.pendingPath;
                if (!openFiles.has(filePath)) {
                    try {
                        openFiles.set(filePath, fs.openSync(filePath, 'r'));
                    } catch {
                        continue;
                    }
                }

                const fd = openFiles.get(filePath)!;
                const length = meta.offset_end - meta.offset_start;
                const buffer = Buffer.alloc(length);
                fs.readSync(fd, buffer, 0, length, meta.offset_start);

                results.push({
                    id: block.blockId,
                    content: this.normalizeStoredContent(buffer.toString('utf-8')),
                    tags: meta.tags,
                    class: meta.class,
                    timestamp: meta.timestamp,
                    score: parseFloat(block.weightScore.toFixed(2)),
                    signature: meta.signature
                });
            }
        } finally {
            for (const fd of openFiles.values()) {
                try { fs.closeSync(fd); } catch { }
            }
        }

        return results;
    }

    public async materializedScan(limit: number = 100, cursor?: string, includeInactive: boolean = false): Promise<{ entries: MemoryBlockDTO[]; nextCursor?: string; generation: number }> {
        // Read the index FIRST, before the scan. Both this call and the internal readIndex()
        // inside scanMemories() will resolve to the same cached ShadowIndex object reference,
        // eliminating the two-call window in which a writeMutex operation could mutate the
        // index between the scan and the materialize pass, producing a skewed view.
        const index = await this.vaultManager.readIndex();
        const scanned = await this.vaultManager.scanMemories(limit, cursor, includeInactive);
        const trace: RetrievalTraceEntry[] = scanned.entries.map(entry => ({
            keyword: '[SCAN]',
            matchedTag: 'N/A',
            blockId: entry.id,
            weightScore: entry.multiplier,
            timestamp: entry.timestamp,
            distance: 0
        }));
        const entries = await this.materialize(trace, index);
        return {
            entries,
            nextCursor: scanned.nextCursor,
            generation: scanned.generation
        };
    }

    /**
     * Executes advanced search with time filters and pagination.
     */
    async advancedSearch(params: { query?: string; fromTs?: number; toTs?: number; limit?: number; tags?: string[]; }): Promise<RetrievalResult> {
        const t0 = performance.now();
        const index = await this.vaultManager.readIndex();

        if (params.query) {
            const baseResult = await this.fastRetrieve(params.query, params.tags);
            let filteredBlocks = baseResult.blocks;

            if (params.fromTs) filteredBlocks = filteredBlocks.filter(b => b.timestamp >= params.fromTs!);
            if (params.toTs) filteredBlocks = filteredBlocks.filter(b => b.timestamp <= params.toTs!);
            if (params.limit) filteredBlocks = filteredBlocks.slice(0, params.limit);

            return {
                blocks: filteredBlocks,
                timings: { ...baseResult.timings, total: parseFloat((performance.now() - t0).toFixed(4)) }
            };
        }

        let entries = Array.from(index.index_table.values());
        entries = entries.filter(b => !b.isSuperseded);
        if (params.fromTs) entries = entries.filter(b => b.timestamp >= params.fromTs!);
        if (params.toTs) entries = entries.filter(b => b.timestamp <= params.toTs!);
        if (params.tags) entries = entries.filter(b => params.tags!.every(t => b.tags.includes(t)));

        const sorted = entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, params.limit || 10);
        const trace: RetrievalTraceEntry[] = sorted.map(b => ({
            keyword: '[TIME_FETCH]', matchedTag: 'N/A', blockId: b.id,
            weightScore: b.multiplier, timestamp: b.timestamp, distance: 0
        }));

        const t1 = performance.now();
        const results = await this.materialize(trace, index);
        const t2 = performance.now();

        return {
            blocks: results,
            timings: {
                indexSearch: 0,
                sorting: parseFloat((t1 - t0).toFixed(4)),
                vaultSlicing: parseFloat((t2 - t1).toFixed(4)),
                total: parseFloat((t2 - t0).toFixed(4))
            }
        };
    }
}
