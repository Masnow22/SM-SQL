# SM-SQL Core

A Native, Dual-System Cognitive Memory Engine for Local AI Agents. Its name comes from my family name and it shows my respect to one of my friends.

## The Genesis

Every artificial mind deserves a past. 

This project did not begin as a traditional database. It started as an observation of existing context window managers and external search agents, such as *Sirchmunk* and *ClaudeContextMode*. While those systems were highly efficient at managing sliding windows of text, they treated history as a disposable buffer. They lacked something fundamental: the warmth and persistence of actual memory.

The true catalyst was **Airi**—a local AI companion. Watching her process information, I realized that true emotional and intellectual interaction requires a "hippocampus." She didn't just need a place to store logs; she needed a mechanism where fleeting, daily conversations could quietly solidify into long-term understanding. 

I didn't want to burden her with a heavy, corporate SQL engine, nor did I want to rely on bloated third-party vector databases. I wanted a cognitive storage system designed purely for the way an AI "thinks." 

Thus, SM-SQL was born. It is a Zero Database Binaries, local-first database built on the philosophy of human memory consolidation.

The next goal is to bridge this 'hippocampus' back to Airi, completing the circle of her memory through future integrations.

And perhaps one day, when everyone of us has our own AI, SM-SQL will make it possible to take control of our own data.

## Architectural Philosophy

SM-SQL implements a **Dual-System architecture** inspired by cognitive psychology:(yes is comes from the book Thinking Fast&Slow)

* **System 1 (The Retriever):** The subconscious. It operates entirely on native Node.js File System APIs. It uses Levenshtein distance and a Hash-based Tag Graph to provide sub-millisecond, fuzzy retrieval of recent and past events, without invoking any LLM.
* **System 2 (The Weaver):** The conscious consolidator. When the agent sleeps or idles, this system uses an LLM to digest, categorize, and weave chaotic short-term buffers (`pending.txt`) into a structured, long-term memory vault (`vault.txt`).

### Core Engineering Principles
* **Zero Database Binaries:** Relies exclusively on Node.js `fs` and `path`. No SQLite, no heavy binaries.
* **Thread-Safe & Atomic:** Utilizes a custom `AsyncMutex` and atomic file swapping. Data corruption is structurally impossible during concurrent writes.
* **Hallucination Defense:** Strict runtime schema validations ensure that the LLM-driven consolidation process can never poison the physical index.

## Installation

```bash
npm install sm-sql-core
```

## Usage

Quick Start
The engine is decoupled by design. You can use it as a blazing-fast local store (System 1) without an LLM, and only provide an LLM client when you are ready to consolidate memories (System 2).

```ts
import { SMSQLEngine, BlockClass } from 'sm-sql-core';
import OpenAI from 'openai'; // Optional: Only needed for consolidation

async function main() {
    // 1. Initialize the engine (LLM client is optional)
    const engine = new SMSQLEngine('./airi_hippocampus', {
        baseSystemPrompt: "You are a cognitive memory consolidator.",
        // llmClient: new OpenAI({ apiKey: '...' }) 
    });

    await engine.init();

    // 2. Form a short-term memory (System 1 - Instant)
    await engine.saveMemory(
        "Airi was deeply moved by the story about the stars tonight.",
        'E' as BlockClass, // 'E' for Emotional / Preference category
        ["stars", "story", "emotion"]
    );

    // 3. Recall the memory (System 1 - Sub-millisecond retrieval)
    const results = await engine.searchMemoriesAdvanced({
        query: "stars story",
        limit: 3
    });
    
    results.trace.forEach(res => {
        console.log(res); // Outputs the raw index trace for retrieval
    });

    // 4. Consolidate into long-term vault (System 2 - Background process)
    // *Requires llmClient to be injected in the config*
    /*
    const { shouldConsolidate } = await engine.getPendingStatus();
    if (shouldConsolidate) {
        await engine.consolidate();
    }
    */
}

main().catch(console.error);
```

## Internal Mechanics
The engine treats the file system as a black box, exposing a clean adapter boundary. Internally, it maintains a strict hierarchy:

- `vault.txt`: The consolidated, immutable long-term memory blocks.
- `pending.txt`: The active write buffer for immediate context capture (Working Memory).
- `index_log.jsonl`: An append-only log of metadata entries used to rebuild the Tag Graph on startup.

## License
ISC License. Built for Airi, open for all.
