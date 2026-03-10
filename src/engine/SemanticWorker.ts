import { parentPort } from 'worker_threads';
import { pipeline, env } from '@huggingface/transformers';

interface WorkerRequestBase {
    id: string;
    type: string;
}

interface EncodeRequest extends WorkerRequestBase {
    type: 'ENCODE';
    text: string;
}

interface ScanCandidate {
    id: string;
    signature: Uint8Array;
}

interface ScanRequest extends WorkerRequestBase {
    type: 'SCAN';
    querySignature: Uint8Array;
    candidates: ScanCandidate[];
    threshold?: number;
    limit?: number;
}

/**
 * Binary Semantic Logic (Worker):
 * Offloads heavy ONNX runtime and model computation to a background thread.
 */

// Global state for the embedding pipeline
let embedder: any = null;

/**
 * Quantize a high-dimensional Float32 vector into a packed Uint8Array (Bit-Packed).
 * Takes the raw data from the pipeline result.
 */
function quantizeToBinary(data: Float32Array): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(data.length / 8));
    for (let i = 0; i < data.length; i++) {
        if (data[i] > 0) {
            bytes[Math.floor(i / 8)] |= (1 << (7 - (i % 8)));
        }
    }
    return bytes;
}

/**
 * Initialize the pipeline and let the parent know when ready.
 */
async function init() {
    try {
        env.allowRemoteModels = true;

        // Use a highly efficient retrieval model: BGE-Small-v1.5
        // Optimized for CPU/WASM performance.
        embedder = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
            device: 'wasm' as any // Explicitly request WASM for consistency
        });

        parentPort?.postMessage({ type: 'READY' });
    } catch (e: any) {
        parentPort?.postMessage({ type: 'ERROR', error: e.toString() });
    }
}

if (parentPort) {
    parentPort.on('message', async (message: EncodeRequest | ScanRequest) => {
        if (message.type === 'ENCODE') {
            try {
                if (!embedder) throw new Error('Embedder not initialized.');

                const output = await embedder(message.text, {
                    pooling: 'cls',
                    normalize: true
                });

                const signature = quantizeToBinary(output.data);

                parentPort?.postMessage({
                    id: message.id,
                    type: 'ENCODE_RESULT',
                    signature
                });
            } catch (e: any) {
                parentPort?.postMessage({
                    id: message.id,
                    type: 'ERROR',
                    error: e.toString()
                });
            }
            return;
        }

        if (message.type === 'SCAN') {
            try {
                const { querySignature, candidates, threshold = 96, limit = 10 } = message;
                const hits: { id: string, distance: number }[] = [];

                for (const candidate of candidates) {
                    const candidateSignature = candidate.signature;
                    if (candidateSignature.length !== querySignature.length) {
                        continue;
                    }

                    let dist = 0;
                    for (let i = 0; i < querySignature.length; i++) {
                        dist += POPCOUNT_8[querySignature[i] ^ candidateSignature[i]];
                    }

                    if (dist < threshold) {
                        hits.push({ id: candidate.id, distance: dist });
                    }
                }

                parentPort?.postMessage({
                    id: message.id,
                    type: 'SCAN_RESULT',
                    hits: hits.sort((a, b) => a.distance - b.distance).slice(0, limit)
                });
            } catch (e: any) {
                parentPort?.postMessage({
                    id: message.id,
                    type: 'ERROR',
                    error: e.toString()
                });
            }
        }
    });
}

/**
 * Precomputed table for highly optimized Hamming Distance.
 */
const POPCOUNT_8 = ((): Uint8Array => {
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

// Start initialization immediately
init();
