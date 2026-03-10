import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import * as readline from 'readline';
import { SMSQLEngine, BlockClass } from '../src/index';
import { MemoryBlockDTO } from '../src/types';

const dotenvResult = dotenv.config({ quiet: true });

const COLORS = {
    reset: '\x1b[0m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
    bold: '\x1b[1m',
    red: '\x1b[31m',
};

type ClassCounts = {
    S: number;
    E: number;
    B: number;
};

type DreamCycleSummary = {
    preGeneration: number;
    postGeneration: number;
    preTotal: number;
    postTotal: number;
    preS: number;
    postS: number;
    newestNewSInsight: string | null;
};

async function withSuppressedOutput<T>(fn: () => Promise<T>): Promise<T> {
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => { };
    console.warn = () => { };
    try {
        return await fn();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
    }
}

function formatPreview(text: string, maxLen: number = 60): string {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 3)}...`;
}

function printBanner(): void {
    console.clear();
    console.log(`${COLORS.bold}${COLORS.cyan}=== SM-SQL Interactive CLI Chat (v1.1.0-alpha) ===${COLORS.reset}`);
    console.log(`${COLORS.gray}Three-tier cognitive memory showcase.${COLORS.reset}`);
    console.log('');
}

function printHelp(): void {
    console.log(`${COLORS.yellow}Available Commands:${COLORS.reset}`);
    console.log('  /help   - Show this help menu');
    console.log('  /dream  - Trigger System 2 memory consolidation');
    console.log('  /vault  - Show vault health and memory class mix');
    console.log('  /exit   - Gracefully shutdown the engine');
    console.log('  [Text]  - Chat with the AI');
    console.log('');
}

async function scanClassCounts(engine: SMSQLEngine, limit: number = 1000): Promise<{ counts: ClassCounts; entries: MemoryBlockDTO[] }> {
    const scan = await engine.scanMemories(limit, undefined, false);
    const counts: ClassCounts = { S: 0, E: 0, B: 0 };

    for (const entry of scan.entries) {
        if (entry.class === BlockClass.S) counts.S += 1;
        if (entry.class === BlockClass.E) counts.E += 1;
        if (entry.class === BlockClass.B) counts.B += 1;
    }

    return { counts, entries: scan.entries };
}

async function runDreamCycle(engine: SMSQLEngine): Promise<DreamCycleSummary> {
    const preSummary = await engine.getVaultSummary();
    const preScan = await scanClassCounts(engine, 1000);
    const preIds = new Set(preScan.entries.map((e) => e.id));

    await withSuppressedOutput(async () => engine.consolidate());

    const postSummary = await engine.getVaultSummary();
    const postScan = await scanClassCounts(engine, 1000);
    const newEntries = postScan.entries.filter((e) => !preIds.has(e.id));
    const newS = newEntries
        .filter((e) => e.class === BlockClass.S)
        .sort((a, b) => b.timestamp - a.timestamp);

    return {
        preGeneration: preSummary.generation,
        postGeneration: postSummary.generation,
        preTotal: preScan.entries.length,
        postTotal: postScan.entries.length,
        preS: preScan.counts.S,
        postS: postScan.counts.S,
        newestNewSInsight: newS[0]?.content ?? null,
    };
}

async function main() {
    printBanner();

    if (dotenvResult.error) {
        console.warn(`${COLORS.gray}[WARN] Failed to load .env: ${dotenvResult.error.message}${COLORS.reset}`);
        console.log('');
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE_URL || process.env.BASE_URL;
    const modelName = process.env.SMSQL_LLM_MODEL || process.env.MODEL_NAME || 'gpt-4o-mini';

    if (!apiKey) {
        console.error(`${COLORS.red}[ERR] OPENAI_API_KEY not found in .env file.${COLORS.reset}`);
        process.exit(1);
    }

    const openai = new OpenAI({
        apiKey,
        baseURL: baseUrl ? (baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`) : undefined,
    });

    const engine = new SMSQLEngine('./sm_sql_chat_vault', {
        llmClient: openai,
        modelName,
        semanticEnabled: true,
        baseSystemPrompt: 'You are a helpful AI assistant with a persistent long-term memory managed by SM-SQL. Use the context to recall users\' details and preferences.',
    });

    await engine.init();
    console.log(`${COLORS.gray}[SYS] Engine initialized at ./sm_sql_chat_vault${COLORS.reset}`);
    console.log('');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${COLORS.bold}${COLORS.cyan}User > ${COLORS.reset}`,
    });

    printHelp();
    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            return;
        }

        if (input.startsWith('/')) {
            const cmd = input.split(' ')[0].toLowerCase();

            if (cmd === '/exit') {
                console.log(`${COLORS.gray}[SYS] Shutting down engine...${COLORS.reset}`);
                await engine.dispose();
                console.log(`${COLORS.green}[OK] Goodbye!${COLORS.reset}`);
                console.log('');
                process.exit(0);
            }

            if (cmd === '/help') {
                printHelp();
                rl.prompt();
                return;
            }

            if (cmd === '/vault') {
                const status = await engine.getVaultSummary();
                const classScan = await scanClassCounts(engine, 1000);

                console.log(`${COLORS.bold}${COLORS.magenta}--- VAULT STATUS ---${COLORS.reset}`);
                console.log(`  Total Active Blocks: ${COLORS.cyan}${status.totalBlocks}${COLORS.reset}`);
                console.log(`  Current Generation:  ${COLORS.cyan}${status.generation}${COLORS.reset}`);
                console.log(`  Pending Buffer Size: ${COLORS.cyan}${status.pending.size} bytes${COLORS.reset}`);
                console.log(`  Class Mix (S/E/B):  ${COLORS.cyan}${classScan.counts.S}/${classScan.counts.E}/${classScan.counts.B}${COLORS.reset}`);
                console.log(`${COLORS.magenta}--------------------${COLORS.reset}`);
                console.log('');
                rl.prompt();
                return;
            }

            if (cmd === '/dream') {
                console.log(`${COLORS.yellow}[S2] Commencing manual dream cycle...${COLORS.reset}`);

                try {
                    const result = await runDreamCycle(engine);
                    const totalDelta = result.postTotal - result.preTotal;
                    const sDelta = result.postS - result.preS;

                    console.log(`${COLORS.green}[OK] Dream cycle complete.${COLORS.reset}`);
                    console.log(`${COLORS.gray}[S2] Generation: ${result.preGeneration} -> ${result.postGeneration}${COLORS.reset}`);
                    console.log(`${COLORS.gray}[S2] Total Blocks: ${result.preTotal} -> ${result.postTotal} (delta ${totalDelta >= 0 ? '+' : ''}${totalDelta})${COLORS.reset}`);
                    console.log(`${COLORS.gray}[S2] S Blocks: ${result.preS} -> ${result.postS} (delta ${sDelta >= 0 ? '+' : ''}${sDelta})${COLORS.reset}`);

                    if (result.newestNewSInsight) {
                        console.log('');
                        console.log(`${COLORS.bold}${COLORS.cyan}New BlockClass.S Insight:${COLORS.reset}`);
                        console.log(`${COLORS.cyan}${result.newestNewSInsight}${COLORS.reset}`);
                    } else {
                        console.log(`${COLORS.yellow}[WARN] No new BlockClass.S insight this cycle.${COLORS.reset}`);
                    }
                } catch (e: any) {
                    console.error(`${COLORS.red}[ERR] Dream failed: ${e.message}${COLORS.reset}`);
                }

                console.log('');
                rl.prompt();
                return;
            }

            console.log(`${COLORS.red}[ERR] Unknown command: ${cmd}. Type /help${COLORS.reset}`);
            console.log('');
            rl.prompt();
            return;
        }

        try {
            process.stdout.write(`${COLORS.yellow}[S1] Searching memory...${COLORS.reset}`);
            const recalled = await engine.searchMemoriesAdvanced({
                query: input,
                limit: 5,
            });

            process.stdout.write(`\r${COLORS.yellow}[S1] Recalled ${recalled.length} fragment(s).${COLORS.reset}\n`);

            if (recalled.length > 0) {
                recalled.forEach((m) => {
                    console.log(`${COLORS.gray}  - [${m.class}] "${formatPreview(m.content, 60)}" (score: ${m.score})${COLORS.reset}`);
                });
            }

            const context = recalled.map((r) => `[Memory ID: ${r.id}] ${r.content}`).join('\n');
            const systemPrompt = `You are a helpful assistant. Use this context if relevant:\n${context}`;

            console.log(`${COLORS.gray}[AI] Thinking...${COLORS.reset}`);
            const response = await openai.chat.completions.create({
                model: engine.config.modelName || 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: input },
                ],
            });

            const reply = response.choices[0].message.content || '[No response]';
            console.log(`${COLORS.bold}${COLORS.green}AI >${COLORS.reset} ${reply}`);
            console.log('');

            const memoryId = await engine.saveMemory(input, 'short-term', ['user_chat', 'chat_examples']);
            console.log(`${COLORS.magenta}[S2] Saved fragment ${memoryId} (pending)${COLORS.reset}`);
            console.log('');
        } catch (error: any) {
            console.error(`${COLORS.red}[ERR] Chat Error: [${error.status || 'Internal'}] ${error.message}${COLORS.reset}`);
            if (error.stack) {
                console.log(`${COLORS.gray}${error.stack}${COLORS.reset}`);
            }
            console.log('');
        }

        rl.prompt();
    });

    rl.on('close', async () => {
        await engine.dispose();
        process.exit(0);
    });
}

main().catch(console.error);
