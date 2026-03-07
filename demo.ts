import { SMSQLEngine } from './src/SMSQLEngine';
import { BlockClass } from './src/types'; // 必须引入类型

async function runDemo() {
  console.log('🚀 启动 SM-SQL 独立纯净测试 (无 LLM 模式)...\n');

  // 初始化引擎，补全必填的 baseSystemPrompt
  const db = new SMSQLEngine('./sm_sql_vault_demo', {
    baseSystemPrompt: "You are a helpful memory consolidation assistant."
  });
  
  await db.init();

  console.log('📦 1. 存入测试记忆 (使用正确的 BlockClass 类型)...\n');
  
  // 使用 'S' as BlockClass 显式转换，或者直接传入
  await db.saveMemory('昨天下午，我和朋友在公园吃了一个红色的苹果。', 'S' as BlockClass, ['昨天', '苹果', '公园']);
  await db.saveMemory('苹果公司的最新款手机今天发布了。', 'S' as BlockClass, ['苹果', '手机']);
  await db.saveMemory('昨天我去看了场电影，非常精彩。', 'S' as BlockClass, ['昨天', '电影']);
  
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('✅ 记忆存入完成！\n');

  console.log('🔍 2. 测试 CJK (中文) 检索与累加计分...');
  console.log('   查询词: "昨天 苹果"');
  
  const result = await db.searchMemoriesAdvanced({
    query: '昨天 苹果',
    limit: 3
  });
  
  // 遍历 trace 数组
  result.trace.forEach((res: any, i: number) => {
    // 根据最新的 SMSQLEngine 结构，内容在 res.block.content 里
    const content = res.block?.content || "内容未解压";
    const score = res.score || 0;
    
    console.log(`   [Top ${i + 1}] 评分: ${Number(score).toFixed(2)} | 内容: ${content.substring(0, 20)}...`);
  });

  console.log('🕒 3. 测试时间切片 API...');
  const now = Date.now();
  const timeResult = await db.getMemoriesByTimeRange(now - 10000, now + 10000, 5);
  // 注意：此处要读取 timeResult.trace.length
  console.log(`   检索到 ${timeResult.trace.length} 条最近的记忆。\n`);

  console.log('💥 4. 测试系统防御...');
  try {
    await db.consolidate();
    console.log('   ❌ 警告：consolidate 居然成功了！');
  } catch (e: any) {
    console.log(`   ✅ 拦截成功！报错信息: ${e.message}\n`);
  }

  console.log('🎉 Demo 测试完成！');
}

runDemo().catch(console.error);