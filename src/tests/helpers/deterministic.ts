/**
 * SM-SQL Test Harness: Deterministic Utilities
 * =============================================
 * Provides factories and mocks to eliminate all sources of non-determinism
 * (network, random IDs, wall-clock time) from the test suite.
 */
import { vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SMSQLEngine } from '../../SMSQLEngine';
import type { SMSQLConfig } from '../../types';

// ---------------------------------------------------------------------------
// 1. Deterministic ID / Clock Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

/**
 * Resets the deterministic ID counter. Call in beforeEach().
 */
export function resetIdCounter(): void {
    _idCounter = 0;
}

/**
 * Returns a predictable monotonic ID string suitable for block IDs.
 * Avoids Math.random() used by VaultManager internally.
 */
export function nextId(prefix = 'test'): string {
    _idCounter++;
    return `${prefix}_${String(_idCounter).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// 2. OpenAI Mock Factory
// ---------------------------------------------------------------------------

/**
 * Creates a lightweight OpenAI-shaped mock that satisfies the constructor
 * signature without any network calls. The `chat.completions.create` method
 * can be overridden per-test via vi.fn().
 */
export function createMockOpenAI() {
    const mockCreate = vi.fn().mockResolvedValue({
        choices: [
            {
                message: {
                    content: JSON.stringify({
                        blocks: [
                            { content: 'Mock consolidated insight.', tags: ['mock_tag'], class: 'S' }
                        ]
                    })
                }
            }
        ]
    });

    return {
        instance: {
            chat: {
                completions: {
                    create: mockCreate,
                },
            },
        } as any, // Satisfies OpenAI typing for config injection
        mockCreate,
    };
}

// ---------------------------------------------------------------------------
// 3. Engine Factory (isolated per-test vault directory)
// ---------------------------------------------------------------------------

let _vaultSeq = 0;

/**
 * Creates an SMSQLEngine pointed at a unique temporary directory.
 * Semantic Intuition is disabled by default (no ONNX worker overhead).
 * Returns the engine and its base directory for assertions.
 */
export async function createTestEngine(
    configOverrides: Partial<SMSQLConfig> = {}
): Promise<{ engine: SMSQLEngine; baseDir: string }> {
    _vaultSeq++;
    const baseDir = path.join(
        process.cwd(),
        `sm_sql_vault_test_${process.pid}_${Date.now()}_${_vaultSeq}`
    );

    const { instance } = createMockOpenAI();

    const config: SMSQLConfig = {
        semanticEnabled: false,
        modelName: 'test-model',
        llmClient: instance,
        baseSystemPrompt: 'Test context.',
        ...configOverrides,
    };

    const engine = new SMSQLEngine(baseDir, config);
    await engine.init();

    return { engine, baseDir };
}

// ---------------------------------------------------------------------------
// 4. Cleanup
// ---------------------------------------------------------------------------

/**
 * Recursively deletes a test vault directory. Call in afterEach/afterAll.
 */
export async function cleanupVault(baseDir: string): Promise<void> {
    try {
        await fs.rm(baseDir, { recursive: true, force: true });
    } catch {
        // Best-effort — CI runners may hold file locks briefly
    }
}
