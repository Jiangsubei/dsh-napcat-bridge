/**
 * DSH NapCat OneBot 11 Probe Log Analyzer
 *
 * 用于分析由 probe-server.ts 收集的 events.jsonl 文件，
 * 提取并归纳 NapCat (OneBot 11) 的真实字段特征、消息段格式及通知事件结构。
 *
 * 用法:
 *   pnpm tsx scripts/analyze-probe.ts [--file logs/probe/events.jsonl]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function parseArgs(): { file: string } {
  const args = process.argv.slice(2);
  let file = path.resolve(process.cwd(), 'logs/probe/events.jsonl');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      file = path.resolve(process.cwd(), args[++i]);
    }
  }
  return { file };
}

const { file } = parseArgs();

if (!fs.existsSync(file)) {
  console.error(`\x1b[31m[错误] 日志文件不存在: ${file}\x1b[0m`);
  console.error(`请先运行 pnpm run probe 启动探针并接收 NapCat 消息后再运行分析。`);
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);

console.log(`\x1b[32m=================================================================\x1b[0m`);
console.log(`\x1b[32m📊 NapCat (OneBot 11) 探针日志分析报告\x1b[0m`);
console.log(`   文件路径: ${file}`);
console.log(`   总事件数: ${lines.length} 条`);
console.log(`\x1b[32m=================================================================\x1b[0m\n`);

const postTypeCounts: Record<string, number> = {};
const segmentTypeCounts: Record<string, number> = {};
const noticeTypeCounts: Record<string, number> = {};
const samples: Record<string, any> = {};

for (const line of lines) {
  let record: any;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  const event = record.event || record;
  const postType = event.post_type || (event.echo ? 'action_response' : 'unknown');

  postTypeCounts[postType] = (postTypeCounts[postType] || 0) + 1;

  if (!samples[postType]) {
    samples[postType] = event;
  }

  // 分析消息段
  if (postType === 'message' || postType === 'message_sent') {
    const key = `${postType}:${event.message_type || 'unknown'}`;
    if (!samples[key]) samples[key] = event;

    const segments = Array.isArray(event.message) ? event.message : [];
    for (const seg of segments) {
      const st = seg.type || 'unknown';
      segmentTypeCounts[st] = (segmentTypeCounts[st] || 0) + 1;
      const segKey = `segment:${st}`;
      if (!samples[segKey]) samples[segKey] = seg;
    }
  }

  // 分析通知
  if (postType === 'notice') {
    const nt = `${event.notice_type || 'unknown'}:${event.sub_type || 'default'}`;
    noticeTypeCounts[nt] = (noticeTypeCounts[nt] || 0) + 1;
    const noticeKey = `notice:${nt}`;
    if (!samples[noticeKey]) samples[noticeKey] = event;
  }
}

// 1. PostType 统计
console.log(`\x1b[36m1. 事件大类分布 (post_type):\x1b[0m`);
for (const [k, v] of Object.entries(postTypeCounts)) {
  console.log(`   - ${k.padEnd(20)}: ${v} 条`);
}
console.log();

// 2. Message Segment 统计
console.log(`\x1b[36m2. 消息段类型分布 (segment types):\x1b[0m`);
if (Object.keys(segmentTypeCounts).length === 0) {
  console.log(`   (暂未收到消息段)`);
} else {
  for (const [k, v] of Object.entries(segmentTypeCounts)) {
    console.log(`   - ${k.padEnd(20)}: ${v} 个`);
  }
}
console.log();

// 3. Notice 统计
console.log(`\x1b[36m3. 通知事件分布 (notice_type):\x1b[0m`);
if (Object.keys(noticeTypeCounts).length === 0) {
  console.log(`   (暂未收到通知事件)`);
} else {
  for (const [k, v] of Object.entries(noticeTypeCounts)) {
    console.log(`   - ${k.padEnd(25)}: ${v} 条`);
  }
}
console.log();

// 4. 各类典型样本结构与关键字段
console.log(`\x1b[36m4. 关键样本字段解析与结构:\x1b[0m\n`);

for (const [sampleKey, sampleData] of Object.entries(samples)) {
  if (sampleKey === 'meta_event' && sampleData.meta_event_type === 'heartbeat') continue; // 跳过普通心跳
  console.log(`--- [样本: ${sampleKey}] ---`);
  console.log(JSON.stringify(sampleData, null, 2));
  console.log();
}

console.log(`\x1b[32m=================================================================\x1b[0m`);
console.log(`分析完成！你可以将上述字段与 docs/DSH-NapCat-QQ插件-Spec.md 进行对照。`);
