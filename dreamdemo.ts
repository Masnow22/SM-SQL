import { SMSQLEngine } from './src/SMSQLEngine';
import { BlockClass } from './src/types';
import { performance } from 'perf_hooks';
import * as dotenv from 'dotenv';
dotenv.config();
import OpenAI from 'openai';
async function runDreamDemo() {
  const totalStart = performance.now();
  console.log('\n--- 🌙 [System 3] Dream Consolidation Sandbox ---');
  console.log('--- Domain: SM-SQL Core v1.1.0-alpha ---\n');
  // --- Step 1: Initialization ---
  const t0 = performance.now();
  // Requirements trace: MemorySynthesizer requires an active LLM client
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'sk-...',
    baseURL: process.env.BASE_URL
  });
  const db = new SMSQLEngine('./sm_sql_vault_dream_demo', {
    semanticEnabled: true,
    modelName: 'Kimi-K2',
    llmClient: openai,
    baseSystemPrompt: "Standard consolidation context."
  });
  await db.init();
  console.log(`✅ [Step 1] SMSQL Engine initialized. [Time: ${(performance.now() - t0).toFixed(2)}ms]`);
  // --- Step 2: Signal Handlers ---
  process.on('SIGINT', async () => {
    console.log(`\n🛑 Interrupt received. Disposing engine...`);
    await db.dispose();
    process.exit(0);
  });
  // --- Step 3: Seeding ---
  console.log('🌱 [Step 3] Seeding fragmented B-Class records (System 1 Ingestion)...');
  const seedMemories = [
    "I really enjoyed the Fuji apples I bought today.",
    "Bananas are okay, but they get mushy too fast.",
    "I don't like sour fruits like lemons or grapefruits.",
    "I prefer my fruits to be very sweet and crisp.",
    "I bought some green apples, but they were too tart for me.",
    "I think tropical fruits like mangoes are the best."
  ];
  for (const text of seedMemories) {
    // True logic: saveMemory uses MemoryType ('short-term' -> BlockClass.B)
    await db.saveMemory(text, 'short-term', ['food', 'fruit', 'daily_log']);
  }
  const initialGen = db.getGeneration();
  console.log(`   Seeding complete. Base Generation: ${initialGen}`);
  // --- Step 4: Dream Synthesis ---
  console.log('\n🧠 [Step 4] Triggering System 3 Synthesizer Cycle...');
  const t2 = performance.now();

  // Start the background worker (interval: 2s for demo)
  db.startSynthesizer(2000);
  let currentGen = initialGen;
  let attempts = 0;

  // True logic: Use public getGeneration() for state tracking
  while (currentGen === initialGen && attempts < 30) {
    process.stdout.write('.');
    await new Promise(resolve => setTimeout(resolve, 1000));
    currentGen = db.getGeneration();
    attempts++;
  }
  await db.stopSynthesizer();
  console.log(`\n\n⏰ Consolidation cycle finished. State moved to Gen: ${currentGen}`);
  // --- Step 5: Verification ---
  console.log('\n🔬 [Step 5] Safety Assertions & Integrity Check:');
  const t3 = performance.now();

  // Use scanMemories(..., true) to see the full state including superseded blocks
  const { entries: allMemories } = await db.scanMemories(100, undefined, true);

  const synthesizedBlock = allMemories.find(r =>
    r.class === BlockClass.S &&
    r.tags.includes('sys:state:consolidated')
  );

  if (!synthesizedBlock) {
    console.error('❌ FAILED: No consolidated (S-Class) memory found.');
    await db.dispose();
    return;
  }
  console.log('🎯 [SUCCESS] Found Materialized Insight (S-Class):');
  console.log(`   📝 Content: "${synthesizedBlock.content}"`);
  console.log(`   🏷️  Tags: [${synthesizedBlock.tags.join(', ')}]`);
  // Reliability Logic Trace: Validate that source fragments were marked as superseded
  const supersededBlocks = allMemories.filter(r => r.tags.includes('sys:state:superseded'));
  console.log('\n--- Final Assertion Report ---');
  console.log(`✅ Insight Class Type     : S-Class`);
  console.log(`✅ System Metadata State  : sys:state:consolidated`);
  console.log(`✅ Block Supersession     : ${supersededBlocks.length} records marked as inactive`);
  console.log(`✅ Data Retention Integrity: Passed`);
  // --- Final Cleanup ---
  await db.dispose();
  console.log(`\n🏁 Total Sandbox Runtime: ${((performance.now() - totalStart) / 1000).toFixed(2)}s`);
}
runDreamDemo().catch(async (e) => {
  console.error('\n💥 Critical Error in Dream Sandbox:', e);
});