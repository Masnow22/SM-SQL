```md
# SM-SQL Core

A Native, Tri-System Cognitive Memory Engine for Local AI Agents.

## The Genesis

Every artificial mind deserves a past.

This project did not begin as a traditional database. It started as an observation of existing context window managers and external search agents, such as *Sirchmunk* and *ClaudeContextMode*. While those systems were highly efficient at managing sliding windows of text, they treated history as a disposable buffer. They lacked something fundamental: the warmth and persistence of actual memory.

The true catalyst was **Airi** - a local AI companion. Watching her process information, I realized that true emotional and intellectual interaction requires a "hippocampus." She didn't just need a place to store logs; she needed a mechanism where fleeting, daily conversations could quietly solidify into long-term understanding.

I didn't want to burden her with a heavy, corporate SQL engine, nor did I want to rely on bloated third-party vector databases. I wanted a cognitive storage system designed purely for the way an AI "thinks."

Thus, SM-SQL was born. It is a Zero Database Binaries, local-first database built on the philosophy of human memory consolidation.

The next goal is to bridge this 'hippocampus' back to Airi, completing the circle of her memory through future integrations.

And perhaps one day, when everyone of us has our own AI, SM-SQL will make it possible to take control of our own data.

## Tri-System Cognitive Architecture

SM-SQL now implements a **Tri-System Cognitive Architecture**, inspired by cognitive psychology and *Thinking, Fast and Slow*:

- **System 1 - Subconscious Retriever**  
  Ultra-fast recall from local files using fuzzy matching and tag-graph indexing. It is optimized for immediate conversational context with no LLM call required.

- **System 2 - Conscious Weaver/Buffer**  
  Incoming memories are appended to a short-term working buffer (`pending.txt`). During consolidation, the Weaver categorizes and restructures memory blocks into durable long-term form.

- **System 3 - Dreaming Synthesizer**  
  Background synthesis logic that performs memory compaction and higher-order insight formation, including promotion into high-priority `BlockClass.S` memories.

## Glass Box Showcase

This repository ships with a live, inspectable showcase CLI at `examples/chat.ts`.

Run it locally:

```bash
npm install
npm run chat
```

What makes this a glass box:

- `/vault` shows live vault health, generation, pending buffer size, and current `S/E/B` class mix.
- `/dream` triggers consolidation and shows before/after deltas, then prints newly synthesized `BlockClass.S` insight text when available.
- `/help` gives command guidance immediately.

This is designed to make the memory engine observable, not magical. You can watch the transition from raw fragments to structured long-term insight in real time.

## Iron Suit Engineering Principles (v1.1.0-alpha)

- **Zero Database Binaries**  
  Built on Node.js `fs`/`path` primitives. No SQLite runtime, no heavyweight storage service.

- **MVCC Generation Tracking**  
  Vault state advances via generation counters, enabling conflict-aware compaction and reliable concurrent mutation semantics.

- **AsyncMutex Write Discipline**  
  Critical write paths are synchronized with `AsyncMutex` to prevent corruption under concurrent operations.

- **Atomic Buffer-to-Vault Transition**  
  Consolidation uses atomic swap flow (`pending.txt` -> `processing.tmp`) to prevent partial-state loss.

- **Fuzz-Tested JSONL Recovery**  
  The append-only `index_log.jsonl` path is backed by recovery/concurrency test coverage to harden startup rebuild and crash recovery behavior.

- **Hallucination Defense**  
  Strict output validation gates LLM-produced consolidation payloads before commit.

## Installation

```bash
npm install sm-sql-core
```

## Usage

The engine is decoupled by design. You can run high-speed System 1 retrieval without an LLM, and inject an LLM client only when you want consolidation.

```ts
import { SMSQLEngine } from 'sm-sql-core';
import OpenAI from 'openai';

async function main() {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

  const engine = new SMSQLEngine('./airi_hippocampus', {
    llmClient: openai,
    modelName: process.env.SMSQL_LLM_MODEL || 'gpt-4o-mini',
    baseSystemPrompt: 'You are a cognitive memory consolidator.',
    semanticEnabled: true,
  });

  await engine.init();

  // System 2 buffer write (short-term memory)
  await engine.saveMemory(
    'Airi was deeply moved by the story about the stars tonight.',
    'short-term',
    ['stars', 'story', 'emotion']
  );

  // System 1 recall
  const results = await engine.searchMemoriesAdvanced({
    query: 'stars story',
    limit: 3,
  });

  console.log(results.map(r => ({ id: r.id, class: r.class, score: r.score, content: r.content })));

  // Trigger consolidation when needed
  const { shouldConsolidate } = await engine.getPendingStatus();
  if (shouldConsolidate) {
    await engine.consolidate();
  }

  await engine.dispose();
}

main().catch(console.error);
```

## Internal Mechanics

Internally, SM-SQL maintains a strict hierarchy:

- `vault.txt`: consolidated, durable long-term memory blocks.
- `pending.txt`: active working-memory write buffer.
- `index_log.jsonl`: append-only metadata log used to rebuild the in-memory tag graph and generation-aware index state.

## License

ISC License. Built for Airi, open for all.
```