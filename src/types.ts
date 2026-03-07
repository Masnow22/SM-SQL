import OpenAI from 'openai';
export enum BlockClass {
    S = 'S', // Survival/Priority: Core rules, critical data (Multiplier: 3.0)
    E = 'E', // Emotional/Subjective: Preferences, subjective context (Multiplier: 2.5)
    B = 'B', // Basic: Ordinary logs, facts (Multiplier: 1.0)
}

export const BlockMultipliers: Record<BlockClass, number> = {
    [BlockClass.S]: 3.0,
    [BlockClass.E]: 2.5,
    [BlockClass.B]: 1.0,
};

export interface SMSQLConfig {
    engineName?: string;
    baseSystemPrompt: string;
    customPromptTemplate?: string;
    llmClient?: OpenAI;
}

// The IndexEntry is stored in index_log.jsonl
export interface IndexEntry {
    id: string;
    class: BlockClass;
    multiplier: number;
    sourceFile: 'vault' | 'pending';
    offset_start: number;
    offset_end: number;
    timestamp: number;
    tags: string[];
}

export interface ShadowIndex {
    system_meta: {
        version: string;
        last_weaved_at: string;
        total_blocks: number;
    };
    // In-memory structures built from JSONL at runtime
    tag_graph: Map<string, Set<string>>; // Maps keyword to Block IDs
    index_table: Map<string, IndexEntry>; // Maps Block IDs to metadata
}

/**
 * Data Transfer Object for retrieval results
 */
export interface MemoryBlockDTO {
    content: string;
    tags: string[];
    class: BlockClass;
    timestamp: number;
    id: string;
}
