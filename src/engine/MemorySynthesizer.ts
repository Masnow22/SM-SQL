import OpenAI from 'openai';
import { SMSQLEngine } from '../SMSQLEngine';
import { BlockClass, CompactionPlan, MemoryBlockDTO } from '../types';

const MIN_BATCH_SIZE = 5;
const MAX_LLM_TAGS = 3;

export class MemorySynthesizer {
    private timer: NodeJS.Timeout | null = null;
    private isRunningCycle = false;
    private cycleAbortController: AbortController | null = null;
    private cyclePromise: Promise<void> = Promise.resolve();

    constructor(private readonly engine: SMSQLEngine) { }

    start(intervalMs: number): void {
        if (this.timer) {
            return;
        }

        if (!this.engine.config.llmClient) {
            console.warn('[SMSQL] MemorySynthesizer requires an llmClient. Worker not started.');
            return;
        }

        const normalizedInterval = Math.max(1000, intervalMs);
        this.timer = setInterval(() => {
            void this.runConsolidationCycle();
        }, normalizedInterval);

        void this.runConsolidationCycle();
    }

    /**
     * Gracefully shuts down the synthesizer.
     * Clears the interval and signals any in-flight LLM request to abort via AbortController.
     * Returns a Promise that resolves only after the current cycle has fully exited its `finally` block.
     */
    stop(): Promise<void> {
        if (!this.timer) {
            // Not running — return current cyclePromise in case an early-fired cycle is still in-flight.
            return this.cyclePromise;
        }

        clearInterval(this.timer);
        this.timer = null;
        this.cycleAbortController?.abort();
        return this.cyclePromise;
    }

    async runConsolidationCycle(): Promise<void> {
        if (this.isRunningCycle) {
            return;
        }

        const client = this.engine.config.llmClient;
        if (!client) {
            console.warn('[SMSQL] MemorySynthesizer cannot run without an llmClient.');
            return;
        }

        this.isRunningCycle = true;
        this.cycleAbortController = new AbortController();

        // Expose a Promise that stop() can await. The resolver is guaranteed to be captured
        // synchronously by the Promise executor before any async boundary is crossed.
        let resolveCycle = () => { };
        this.cyclePromise = new Promise<void>(resolve => { resolveCycle = resolve; });

        try {
            const { entries, generation } = await this.engine.scanMemories(20, undefined, false);
            const batch = entries.filter(entry => entry.class === BlockClass.B);

            if (batch.length < MIN_BATCH_SIZE) {
                console.log(`[SMSQL] MemorySynthesizer: only ${batch.length} B-blocks found (need ${MIN_BATCH_SIZE}). Skipping cycle.`);
                return;
            }

            const { summary, tags } = await this.synthesizeBatch(client, batch, this.cycleAbortController.signal);
            const finalTags = ['sys:state:consolidated', ...tags];

            const plan: CompactionPlan = {
                additions: [{
                    content: summary,
                    class: BlockClass.S,
                    tags: finalTags
                }],
                supersedeIds: batch.map(entry => entry.id),
                expectedGeneration: generation
            };

            try {
                await this.engine.commitCompaction(plan);
                console.log(`[SMSQL] MemorySynthesizer committed. ${batch.length} B-blocks → 1 S-block. Tags: [${finalTags.join(', ')}]`);
            } catch (error) {
                if (this.isMvccConflict(error)) {
                    console.warn('[SMSQL] MemorySynthesizer detected an MVCC conflict. Retrying next cycle.');
                    return;
                }
                throw error;
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                console.log('[SMSQL] MemorySynthesizer cycle aborted (graceful shutdown).');
                return;
            }
            console.error('[SMSQL] MemorySynthesizer cycle failed:', error);
        } finally {
            this.isRunningCycle = false;
            this.cycleAbortController = null;
            resolveCycle();
        }
    }

    /**
     * Calls the LLM with a structured two-field output contract.
     * Uses maxRetries: 0 — the interval-based scheduler is the retry mechanism.
     * Passes an AbortSignal so stop() can cancel any in-flight HTTP request immediately.
     */
    private async synthesizeBatch(
        client: OpenAI,
        batch: MemoryBlockDTO[],
        signal: AbortSignal
    ): Promise<{ summary: string; tags: string[] }> {
        const model = this.engine.config.modelName || process.env.SMSQL_LLM_MODEL || 'gpt-4o';

        const response = await client.chat.completions.create(
            {
                model,
                temperature: 0.2,
                messages: [
                    {
                        role: 'system',
                        content: [
                            'You are a data compactor. Synthesize the following fragmented data entries into a single, cohesive insight.',
                            'Remove redundancies and resolve contradictions when possible.',
                            '',
                            'You MUST respond using this exact two-line format and absolutely nothing else:',
                            'SUMMARY: <concise natural-language synthesis in one sentence>',
                            'TAGS: <1 to 3 highly abstract, comma-separated tags that categorize this insight>'
                        ].join('\n')
                    },
                    {
                        role: 'user',
                        content: [
                            'Synthesize these data entries:',
                            '',
                            ...batch.map((entry, index) => `Entry ${index + 1}: ${entry.content}`)
                        ].join('\n')
                    }
                ]
            },
            { timeout: 120000, maxRetries: 0, signal }
        );

        const raw = (response.choices[0]?.message?.content || '').trim();
        return this.parseStructuredResponse(raw);
    }

    /**
     * Parses the two-line structured LLM response.
     *
     * Regex is tolerant of:
     *   - Case variations (summary:, SUMMARY:, Summary:)
     *   - Markdown bold wrappers (**SUMMARY:**, **SUMMARY**:)
     *   - Spaces before the colon (summary :)
     *
     * HARD CONTRACT: If no parseable, non-empty SUMMARY line is found, throws immediately.
     * The caller's outer try/catch will catch this, log it, and cleanly abort the cycle
     * without committing any partial memory to the vault.
     */
    private parseStructuredResponse(raw: string): { summary: string; tags: string[] } {
        // \*{0,2} tolerates Markdown bold wrapping the keyword or the colon
        const summaryMatch = raw.match(/^\*{0,2}\s*summary\s*\*{0,2}\s*:+\*{0,2}\s*(.+)/im);
        const tagsMatch = raw.match(/^\*{0,2}\s*tags?\s*\*{0,2}\s*:+\*{0,2}\s*(.+)/im);

        const summary = summaryMatch?.[1]?.trim() ?? '';

        if (!summary) {
            throw new Error(
                `[SMSQL] MemorySynthesizer: LLM response did not contain a parseable SUMMARY field. ` +
                `Aborting cycle to prevent committing a partial or empty memory.\n` +
                `Raw LLM output was:\n${raw}`
            );
        }

        const tags = tagsMatch
            ? tagsMatch[1]
                .split(',')
                .map(t => this.sanitizeLlmTag(t))
                .filter((t): t is string => t !== null)
                .slice(0, MAX_LLM_TAGS)
            : [];

        return { summary, tags };
    }

    /**
     * Sanitizes a single LLM-generated tag against namespace injection.
     *
     * Rules (zero-tolerance):
     *   1. Strip all colons — prevents `sys:state:` style forgery.
     *   2. Normalize to lowercase_underscore.
     *   3. Hard-reject any tag whose normalized form starts with `sys`, `sys_`, or `sys-`.
     *      The LLM is physically barred from forging system state tags.
     *   4. Reject empty or single-character strings.
     *
     * Returns null for rejected tags — callers must filter out nulls.
     */
    private sanitizeLlmTag(raw: string): string | null {
        // Step 1: strip colons before any other normalization to defeat `sys:state:` forgery
        const decoloned = raw.replace(/:/g, '');

        // Step 2: normalize to lowercase_underscore
        const normalized = decoloned.trim().toLowerCase().replace(/\s+/g, '_');

        // Step 3: namespace injection guard — reject any sys variant
        if (/^sys[-_]?/.test(normalized) || normalized === 'sys') {
            console.warn(`[SMSQL] MemorySynthesizer: LLM attempted to forge a protected sys namespace tag: "${raw}". Rejected.`);
            return null;
        }

        // Step 4: require meaningful content
        if (normalized.length < 2) return null;

        return normalized;
    }

    private isMvccConflict(error: unknown): boolean {
        return error instanceof Error && error.message.includes('MVCC Conflict');
    }
}
