import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/tests/**/*.test.ts'],
        testTimeout: 30000,
        pool: 'forks',
        benchmark: {
            include: ['src/bench/**/*.bench.ts'],
        },
    },
});
