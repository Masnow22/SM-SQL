import * as fs from 'fs/promises';
import { readSync, openSync, closeSync, renameSync, existsSync } from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { VaultManager } from './vault';
import { BlockClass, BlockMultipliers, ShadowIndex, IndexEntry, SMSQLConfig } from './types';

class AsyncMutex {
    private queue: Promise<void> = Promise.resolve();

    async run<T>(callback: () => Promise<T>): Promise<T> {
        const next = this.queue.then(() => callback());
        this.queue = next.then(() => { }, () => { });
        return next;
    }
}

export class Weaver {
    private vaultManager: VaultManager;
    private client: OpenAI | undefined;
    private config: SMSQLConfig;
    private writeMutex = new AsyncMutex();

    constructor(vaultManager: VaultManager, client: OpenAI | undefined, config: SMSQLConfig) {
        this.vaultManager = vaultManager;
        this.client = client;
        this.config = config;
    }

    private getSystemPrompt(): string {
        return `
${this.config.baseSystemPrompt}
Your task is to analyze raw context logs and categorize them into the SM-SQL storage system.

Block Classes:
- S (Survival/Priority): Core rules, critical identity, or immutable facts.
- E (Emotional/Subjective): User preferences, feelings, and relational context.
- B (Basic): General facts, casual conversation, and low-priority logs.

Output Format (STRICT JSON):
{
  "blocks": [
    {
      "content": "Consolidated summary of the log entry",
      "tags": ["Tag1", "Tag2"],
      "class": "S" | "E" | "B"
    }
  ]
}
    `.trim();
    }

    /**
     * Executes System 2: LLM-driven consolidation of the pending buffer into the persistent vault.
     */
    async weavePendingLogs(baseDir: string): Promise<void> {
        if (!this.client) {
            throw new Error('LLM Client (OpenAI) is required for Weaver consolidation. Please provide it in SMSQLConfig.');
        }
        const pendingPath = path.join(baseDir, 'pending.txt');
        const processingTmpPath = path.join(baseDir, 'processing.tmp');
        const vaultPath = path.join(baseDir, 'vault.txt');
        const indexLogPath = path.join(baseDir, 'index_log.jsonl');

        console.log('[Weaver: IO] 🧵 The Weaver is starting...');

        try {
            if (!existsSync(pendingPath)) {
                console.log('[Weaver: IO] 📭 No pending logs found.');
                return;
            }
            renameSync(pendingPath, processingTmpPath);
            console.log(`[Weaver: IO] ✅ Atomic Swap: ${pendingPath} -> ${processingTmpPath}`);
        } catch (e: any) {
            if (e.code === 'ENOENT') {
                console.log('[Weaver: IO] 📭 Pending file vanished during swap.');
                return;
            }
            throw e;
        }

        const pendingContent = await fs.readFile(processingTmpPath, 'utf-8');
        if (!pendingContent.trim()) {
            console.log('[Weaver: IO] 📭 Swapped buffer is empty.');
            await fs.unlink(processingTmpPath);
            return;
        }

        console.log(`[Weaver: AI] 🤖 consulting LLM for storage categorization...`);
        let blocks: any[];
        try {
            blocks = await this.categorizeLogs(pendingContent);
        } catch (e) {
            console.error('[Weaver: AI] ❌ LLM classification failed. Holding processing.tmp for retry.');
            throw e;
        }

        await this.writeMutex.run(async () => {
            for (const block of blocks) {
                const timestamp = Date.now();
                const blockId = `woven_${timestamp}_${Math.random().toString(36).substring(2, 7)}`;

                const currentVaultStats = await fs.stat(vaultPath);
                const offset_start = currentVaultStats.size;

                const entry = `[${blockId}] [${block.class}] [${new Date(timestamp).toISOString()}]\n${block.content}\n---\n`;
                const entryBuffer = Buffer.from(entry, 'utf-8');

                await fs.appendFile(vaultPath, entryBuffer);
                const offset_end = offset_start + entryBuffer.length;

                const integrityOk = await this.verifyIntegrity(vaultPath, offset_start, entry);
                if (!integrityOk) {
                    throw new Error('SM-SQL Integrity Mismatch during weaving.');
                }

                const indexEntry: IndexEntry = {
                    id: blockId,
                    class: block.class as BlockClass,
                    multiplier: BlockMultipliers[block.class as BlockClass],
                    sourceFile: 'vault',
                    offset_start,
                    offset_end,
                    timestamp,
                    tags: block.tags || []
                };

                await fs.appendFile(indexLogPath, JSON.stringify(indexEntry) + '\n', 'utf-8');
            }
        });

        await fs.unlink(processingTmpPath);
        console.log('[Weaver: IO] ✨ Weaving complete.');

        await this.vaultManager.clearCache();
        await this.vaultManager.readIndex();
    }

    private isValidWeaverOutput(data: any): data is { blocks: any[] } {
        if (!data || typeof data !== 'object' || !Array.isArray(data.blocks)) return false;
        for (const block of data.blocks) {
            if (typeof block.content !== 'string' || !block.content.trim()) return false;
            if (!['S', 'E', 'B'].includes(block.class)) return false;
            if (!Array.isArray(block.tags) || !block.tags.every((t: any) => typeof t === 'string')) return false;
        }
        return true;
    }

    private async categorizeLogs(content: string): Promise<any[]> {
        if (!this.client) throw new Error('LLM Client not initialized.');
        const response = await this.client.chat.completions.create({
            model: process.env.MODEL_NAME || "gpt-4-turbo-preview",
            messages: [
                { role: "system", content: this.getSystemPrompt() },
                { role: "user", content: `Categorize these logs:\n${content}` }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1
        }, { timeout: 120000, maxRetries: 2 });

        const rawContent = response.choices[0].message.content || '{"blocks": []}';
        try {
            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            const sanitized = jsonMatch ? jsonMatch[0] : rawContent;
            const result = JSON.parse(sanitized);

            if (!this.isValidWeaverOutput(result)) throw new Error('Schema Validation Failed');
            return result.blocks;
        } catch (error) {
            console.warn(`[Weaver: IO] ⚠️ Categorization failure, using fallback.`);
            return [{
                content: `Storage Fallback: Encountered error during LLM categorization. Original text: ${content.substring(0, 200)}...`,
                tags: ["Uncategorized", "Storage_Fallback"],
                class: "B"
            }];
        }
    }

    private async verifyIntegrity(filePath: string, offset: number, expected: string): Promise<boolean> {
        const expectedBuffer = Buffer.from(expected, 'utf-8');
        const actualBuffer = Buffer.alloc(expectedBuffer.length);
        const fd = openSync(filePath, 'r');
        try { readSync(fd, actualBuffer, 0, expectedBuffer.length, offset); }
        finally { closeSync(fd); }
        return actualBuffer.equals(expectedBuffer);
    }
}
