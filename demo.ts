import { SMSQLEngine } from './src/SMSQLEngine';
import { BlockClass } from './src/types';

async function runDemo() {
  console.log('Starting SM-SQL independent test (No-LLM mode)...\n');

  // Initialize engine with a required base system prompt
  const db = new SMSQLEngine('./sm_sql_vault_demo', {
    baseSystemPrompt: "You are a helpful memory consolidation assistant."
  });
  
  await db.init();

  console.log('1. Storing test memories (using explicit BlockClass types)...\n');
  
  // Storing sample data using 'S' (Semantic) class
  await db.saveMemory(
    'Yesterday afternoon, I ate a red apple with a friend in the park.', 
    'S' as BlockClass, 
    ['yesterday', 'apple', 'park']
  );
  await db.saveMemory(
    'Apple Inc. released their latest phone today.', 
    'S' as BlockClass, 
    ['apple', 'phone']
  );
  await db.saveMemory(
    'I watched a movie yesterday, it was wonderful.', 
    'S' as BlockClass, 
    ['yesterday', 'movie']
  );
  
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('Memory storage complete.\n');

  console.log('2. Testing cross-language retrieval and score accumulation...');
  console.log('   Query terms: "yesterday apple"');
  
  const result = await db.searchMemoriesAdvanced({
    query: 'yesterday apple',
    limit: 3
  });
  
  // Iterate through retrieval trace
  result.trace.forEach((res: any, i: number) => {
    const content = res.block?.content || "Content extraction failed";
    const score = res.score || 0;
    
    console.log(`   [Top ${i + 1}] Score: ${Number(score).toFixed(2)} | Content: ${content.substring(0, 40)}...`);
  });

  console.log('\n3. Testing Time Range API...');
  const now = Date.now();
  const timeResult = await db.getMemoriesByTimeRange(now - 10000, now + 10000, 5);
  console.log(`   Retrieved ${timeResult.trace.length} recent memory entries.\n`);

  console.log('4. Testing system defense (Consolidation Guard)...');
  try {
    // This should fail as no llmClient was provided during initialization
    await db.consolidate();
    console.log('   Warning: consolidate unexpectedly succeeded!');
  } catch (e: any) {
    console.log(`   Guard active. Expected error caught: ${e.message}\n`);
  }

  console.log('Demo test complete.');
}

runDemo().catch(console.error);
