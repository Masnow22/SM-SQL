import { performance } from 'perf_hooks';
import { SMSQLEngine } from './src/SMSQLEngine';

async function runSemanticDemo() {
  console.log('🧠 Starting SM-SQL Binary Semantic Intuition Test...\n');

  // 1. 初始化引擎，并开启 semanticEnabled
  const startInit = performance.now();
  const db = new SMSQLEngine('./sm_sql_vault_semantic', {
    baseSystemPrompt: "You are a helpful memory assistant.",
    semanticEnabled: true 
  });
  await db.init();
  console.log(`[Worker] Semantic Engine initialized and warmed up in ${(performance.now() - startInit).toFixed(2)}ms\n`);

  console.log('📥 1. Storing an English memory with NO Chinese tags...');
  
  // 存入一段纯英文的苹果相关记忆
  await db.saveMemory(
    'I bought some fresh green apples and bananas from the supermarket.',
    'core',
    ['supermarket', 'apple', 'banana'] // 注意：没有任何“水果”相关的中文字眼
  );

  // 等待异步签名生成和落盘
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('   Storage completed.\n');

  console.log('🔍 2. Testing Cross-Lingual Semantic Fallback...');
  console.log('   Query: "我想吃点美味的水果" (I want to eat some delicious fruit)\n');

  const startSearch = performance.now();
  
  // 刻意使用没有字面重合的中文进行检索
  const results = await db.searchMemoriesAdvanced({
    query: '我想吃点美味的水果',
    limit: 1
  });
  const searchDuration = performance.now() - startSearch;

  if (results.length > 0) {
    const hit = results[0];
    console.log('🎯 [SEMANTIC HIT!]');
    console.log(`   Score: ${hit.score.toFixed(2)} (Hamming Similarity)`);
    console.log(`   Content: "${hit.content}"`);
    console.log(`   Signature (Base64 prefix): ${hit.signature?.substring(0, 15)}...`);
  } else {
    console.log('   No memories found. Fallback failed.');
  }
  
  console.log(`\nSearch completed in ${searchDuration.toFixed(2)}ms\n`);
}

runSemanticDemo().catch(console.error);