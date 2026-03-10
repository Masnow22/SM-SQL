import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';

interface WorkerMessage {
    id?: string;
    type: string;
    error?: string;
    signature?: Uint8Array;
    hits?: Array<{ id: string; distance: number }>;
}

interface PendingRequest<T> {
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
    timeout: NodeJS.Timeout;
}

/**
 * Binary Semantic Intuition (P1-B):
 * Provides fast semantic search using Binary Quantized embeddings and Hamming Distance.
 */
export class SemanticIntuition {
    private worker: Worker | null = null;
    private initialized = false;
    private initPromise: Promise<void> | null = null;
    private initResolve: (() => void) | null = null;
    private initReject: ((error: Error) => void) | null = null;
    private requestSeq = 0;
    private readonly pendingRequests = new Map<string, PendingRequest<unknown>>();
    private readonly requestTimeoutMs = 30000;

    constructor(private enabled: boolean) { }

    /**
     * Precomputes the POPCOUNT_8 table for highly optimized Hamming Distance calculations.
     */
    private static readonly POPCOUNT_8 = ((): Uint8Array => {
        const table = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            let count = 0;
            let n = i;
            while (n > 0) {
                if (n & 1) count++;
                n >>= 1;
            }
            table[i] = count;
        }
        return table;
    })();

    /**
     * Optimized Hamming Distance using POPCOUNT_8 table.
     */
    public static distance(a: Uint8Array, b: Uint8Array): number {
        if (a.length !== b.length) return Infinity;
        let dist = 0;
        for (let i = 0; i < a.length; i++) {
            dist += this.POPCOUNT_8[a[i] ^ b[i]];
        }
        return dist;
    }

    /**
     * Warms up the semantic model in a worker thread.
     */
    public async init(): Promise<void> {
        if (!this.enabled || this.initialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = new Promise<void>((resolve, reject) => {
            this.initResolve = resolve;
            this.initReject = reject;

            let workerPath = path.join(__dirname, 'SemanticWorker.js');
            if (!fs.existsSync(workerPath)) {
                // Support development environments where .ts files are run directly via tsx/ts-node
                workerPath = path.join(__dirname, 'SemanticWorker.ts');
            }
            this.worker = new Worker(workerPath);

            this.worker.on('message', this.handleWorkerMessage);
            this.worker.on('error', this.handleWorkerError);
            this.worker.on('exit', this.handleWorkerExit);
        });

        return this.initPromise;
    }

    /**
     * Encodes text into a Binary Quantized signature (Uint8Array).
     */
    public async encode(text: string): Promise<Uint8Array> {
        this.ensureReady();

        const message = await this.sendRequest<WorkerMessage>({
            type: 'ENCODE',
            text
        });

        if (message.type === 'ERROR') {
            throw new Error(message.error || 'Semantic worker encode failed.');
        }

        if (message.type !== 'ENCODE_RESULT' || !message.signature) {
            throw new Error(`Unexpected worker response type: ${message.type}`);
        }

        return message.signature;
    }

    /**
     * Offloads a large-scale Hamming Distance scan to the worker thread.
     */
    public async scan(querySignature: Uint8Array, candidates: Array<{ id: string; signature: Uint8Array }>): Promise<Array<{ id: string; distance: number }>> {
        this.ensureReady();

        const querySignatureCopy = Uint8Array.from(querySignature);
        const workerCandidates = candidates.map(candidate => ({
            id: candidate.id,
            signature: Uint8Array.from(candidate.signature)
        }));

        const transferList: Array<ArrayBuffer> = [querySignatureCopy.buffer as ArrayBuffer];
        for (const candidate of workerCandidates) {
            transferList.push(candidate.signature.buffer as ArrayBuffer);
        }

        const message = await this.sendRequest<WorkerMessage>({
            type: 'SCAN',
            querySignature: querySignatureCopy,
            candidates: workerCandidates,
            threshold: 96,
            limit: 10
        }, transferList);

        if (message.type === 'ERROR') {
            throw new Error(message.error || 'Semantic worker scan failed.');
        }

        if (message.type !== 'SCAN_RESULT' || !message.hits) {
            throw new Error(`Unexpected worker response type: ${message.type}`);
        }

        return message.hits;
    }

    public isEnabled(): boolean {
        return this.enabled && this.initialized;
    }

    /**
     * Terminates the background WASM/ONNX worker thread.
     * Rejects all pending requests so their callers don't hang on orphaned timeouts.
     * Called by SMSQLEngine.dispose() during full engine teardown.
     */
    public async terminate(): Promise<void> {
        if (!this.worker) return;

        const workerToTerminate = this.worker;
        this.worker = null;
        this.initialized = false;
        this.initPromise = null;

        this.rejectAllPending(new Error('[SMSQL] SemanticIntuition terminated during engine disposal.'));

        await workerToTerminate.terminate();
    }

    /**
     * Utility to convert Float32Array to Binary Uint8Array via bit-packing.
     */
    public static quantizeToBinary(embedding: Float32Array): Uint8Array {
        const bytes = new Uint8Array(Math.ceil(embedding.length / 8));
        for (let i = 0; i < embedding.length; i++) {
            if (embedding[i] > 0) {
                bytes[Math.floor(i / 8)] |= (1 << (7 - (i % 8)));
            }
        }
        return bytes;
    }

    private ensureReady(): void {
        if (!this.enabled || !this.initialized || !this.worker) {
            throw new Error('Semantic Intuition not initialized or enabled.');
        }
    }

    private nextRequestId(): string {
        this.requestSeq += 1;
        return `req_${Date.now()}_${this.requestSeq}`;
    }

    private sendRequest<T extends WorkerMessage>(payload: Record<string, unknown>, transferList?: Array<ArrayBuffer>): Promise<T> {
        if (!this.worker) {
            return Promise.reject(new Error('Semantic worker is not available.'));
        }

        const requestId = this.nextRequestId();

        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingRequests.delete(requestId)) {
                    reject(new Error(`Semantic worker timeout for request ${requestId}.`));
                }
            }, this.requestTimeoutMs);

            this.pendingRequests.set(requestId, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timeout
            });

            if (transferList && transferList.length > 0) {
                this.worker!.postMessage({ id: requestId, ...payload }, transferList);
            } else {
                this.worker!.postMessage({ id: requestId, ...payload });
            }
        });
    }

    private handleWorkerMessage = (message: WorkerMessage): void => {
        if (message.type === 'READY') {
            this.initialized = true;
            this.initResolve?.();
            this.initResolve = null;
            this.initReject = null;
            return;
        }

        if (message.type === 'ERROR' && !message.id) {
            const error = new Error(message.error || 'Semantic worker initialization failed.');
            this.initReject?.(error);
            this.initResolve = null;
            this.initReject = null;
            this.rejectAllPending(error);
            return;
        }

        if (!message.id) {
            return;
        }

        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.type === 'ERROR') {
            pending.reject(new Error(message.error || 'Semantic worker request failed.'));
            return;
        }

        pending.resolve(message);
    };

    private handleWorkerError = (error: Error): void => {
        this.initReject?.(error);
        this.initResolve = null;
        this.initReject = null;
        this.rejectAllPending(error);
    };

    private handleWorkerExit = (code: number): void => {
        const error = code === 0
            ? new Error('Semantic worker exited unexpectedly.')
            : new Error(`Semantic worker stopped with exit code ${code}.`);

        this.initReject?.(error);
        this.initResolve = null;
        this.initReject = null;
        this.rejectAllPending(error);
        this.worker = null;
        this.initialized = false;
        this.initPromise = null;
    };

    private rejectAllPending(error: Error): void {
        for (const [requestId, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(error);
            this.pendingRequests.delete(requestId);
        }
    }
}
