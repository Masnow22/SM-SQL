import * as fs from 'fs';
import { VaultManager } from './vault';
import { ShadowIndex, BlockClass, IndexEntry } from './types';

export interface RetrievalTraceEntry {
    keyword: string;
    matchedTag: string;
    blockId: string;
    weightScore: number;
    timestamp: number;
    distance: number;
}

export interface RetrievalResult {
    content: string;
    trace: RetrievalTraceEntry[];
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

    constructor(vaultManager: VaultManager, vaultPath: string, pendingPath: string) {
        this.vaultManager = vaultManager;
        this.vaultPath = vaultPath;
        this.pendingPath = pendingPath;
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

    /**
     * Executes System 1: Lightweight fuzzy search through the indexed tag graph.
     */
    async fastRetrieve(userInput: string): Promise<RetrievalResult> {
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
                            const existing = hitMap.get(id);
                            if (existing) {
                                existing.hitCount++;
                                // Keep the best (lowest distance) hit for the trace
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

        // Ranking: (Base Score * Hit Multiplier) + Recency - Distance
        const trace = Array.from(hitMap.values()).map(h => {
            // Apply additive scoring: hitCount bonus
            const hitMultiplier = 1 + (h.hitCount - 1) * 0.5;
            const updatedScore = h.entry.weightScore * hitMultiplier;
            return { ...h.entry, weightScore: updatedScore };
        });

        let sortedBlocks = trace.sort((a, b) => {
            const rawScoreA = a.weightScore * (1 + (a.timestamp / Date.now()));
            const accScoreA = rawScoreA - (a.distance * 0.5);
            const rawScoreB = b.weightScore * (1 + (b.timestamp / Date.now()));
            const accScoreB = rawScoreB - (b.distance * 0.5);
            return accScoreB - accScoreA;
        }).slice(0, 10);

        // Fallback: Priority blocks (Class S)
        if (sortedBlocks.length === 0) {
            const sBlocks = Array.from(index.index_table.values())
                .filter(m => m.class === BlockClass.S)
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 2);

            for (const meta of sBlocks) {
                sortedBlocks.push({
                    keyword: "[FALLBACK]", matchedTag: "Priority_Block", blockId: meta.id,
                    weightScore: meta.multiplier, timestamp: meta.timestamp, distance: 0
                });
            }
        }
        const t3 = performance.now();
        const { content } = await this.materialize(sortedBlocks, index);
        const t4 = performance.now();

        return {
            content,
            trace: sortedBlocks,
            timings: {
                indexSearch: parseFloat((t2 - t1).toFixed(4)),
                sorting: parseFloat((t3 - t2).toFixed(4)),
                vaultSlicing: parseFloat((t4 - t3).toFixed(4)),
                total: parseFloat((t4 - t0).toFixed(4))
            }
        };
    }

    private async materialize(blocks: RetrievalTraceEntry[], index: ShadowIndex): Promise<{ content: string }> {
        let finalContent = "";
        if (blocks.length > 0) {
            const openFiles: Map<string, number> = new Map();
            try {
                for (const block of blocks) {
                    const meta = index.index_table.get(block.blockId);
                    if (!meta) continue;

                    const filePath = meta.sourceFile === 'vault' ? this.vaultPath : this.pendingPath;
                    if (!openFiles.has(filePath)) {
                        try {
                            openFiles.set(filePath, fs.openSync(filePath, 'r'));
                        } catch (e) { continue; }
                    }

                    const fd = openFiles.get(filePath)!;
                    const length = meta.offset_end - meta.offset_start;
                    const buffer = Buffer.alloc(length);
                    fs.readSync(fd, buffer, 0, length, meta.offset_start);
                    finalContent += buffer.toString('utf-8') + "\n";
                }
            } finally {
                for (const fd of openFiles.values()) {
                    try { fs.closeSync(fd); } catch { }
                }
            }
        }
        return { content: finalContent.trim() };
    }

    /**
     * Executes advanced search with time filters and pagination.
     */
    async advancedSearch(params: { query?: string; fromTs?: number; toTs?: number; limit?: number; }): Promise<RetrievalResult> {
        const t0 = performance.now();
        const index = await this.vaultManager.readIndex();

        // 1. If query is provided, use the fuzzy tag search
        if (params.query) {
            const baseResult = await this.fastRetrieve(params.query);
            let filteredTrace = baseResult.trace;

            if (params.fromTs) filteredTrace = filteredTrace.filter(t => t.timestamp >= params.fromTs!);
            if (params.toTs) filteredTrace = filteredTrace.filter(t => t.timestamp <= params.toTs!);
            if (params.limit) filteredTrace = filteredTrace.slice(0, params.limit);

            const { content } = await this.materialize(filteredTrace, index);
            return {
                content,
                trace: filteredTrace,
                timings: { ...baseResult.timings, total: parseFloat((performance.now() - t0).toFixed(4)) }
            };
        }

        // 2. Pure chronological fetch
        let blocks = Array.from(index.index_table.values());
        if (params.fromTs) blocks = blocks.filter(b => b.timestamp >= params.fromTs!);
        if (params.toTs) blocks = blocks.filter(b => b.timestamp <= params.toTs!);

        const sorted = blocks.sort((a, b) => b.timestamp - a.timestamp).slice(0, params.limit || 10);
        const trace: RetrievalTraceEntry[] = sorted.map(b => ({
            keyword: "[TIME_FETCH]", matchedTag: "N/A", blockId: b.id,
            weightScore: b.multiplier, timestamp: b.timestamp, distance: 0
        }));

        const t1 = performance.now();
        const { content } = await this.materialize(trace, index);
        const t2 = performance.now();

        return {
            content,
            trace,
            timings: {
                indexSearch: 0,
                sorting: parseFloat((t1 - t0).toFixed(4)),
                vaultSlicing: parseFloat((t2 - t1).toFixed(4)),
                total: parseFloat((t2 - t0).toFixed(4))
            }
        };
    }
}
