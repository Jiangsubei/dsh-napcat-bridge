import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import {
  filterAndExtractOutboundBlocks,
  OutboundStreamBridge,
} from '../../src/outbound/stream.js';
import { stripMarkdown } from '../../src/outbound/render.js';

describe('契约测试: 出方向事件过滤与 Markdown 纯文本渲染 (Outbound & Strip Contract)', () => {
  it('契约 1: 仅正式回复 TextBlock 被提取发往 QQ，思考与工具块坚决过滤', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'reasoning',
        text: '让我思考一下用户的需求，首先需要调用天气工具...',
      },
      {
        type: 'tool-call',
        id: 'call_123' as any,
        name: 'get_weather',
        arguments: '{"city":"Beijing"}',
      },
      {
        type: 'text',
        text: '北京今天天气晴朗，气温 25 度。',
      },
    ];

    // 调用真实出站过滤模块
    const formalTextBlocks = filterAndExtractOutboundBlocks(blocks);
    expect(formalTextBlocks).toHaveLength(1);
    expect(formalTextBlocks[0].text).toBe('北京今天天气晴朗，气温 25 度。');

    const combinedText = formalTextBlocks.map((b) => b.text).join('\n');
    expect(combinedText).not.toContain('让我思考一下');
    expect(combinedText).not.toContain('get_weather');
  });

  it('契约 2: stripMarkdown 算法剥离语法符号，生成适合 QQ 的纯文本排版', () => {
    const md = `### 系统运行报告
**状态**: 正常运行
*详情*: 当前 CPU 负载 _20%_
这是一个 \`npm test\` 命令。
[官方文档](https://deepseek.com)

\`\`\`bash
pnpm run build
pnpm test
\`\`\`

| 服务 | 状态 |
|---|---|
| Gateway | 在线 |
| Agent | 就绪 |
`;

    // 调用真实 Markdown 剥离模块
    const plain = stripMarkdown(md);

    // 断言: 标题转换为中文括号
    expect(plain).toContain('【系统运行报告】');
    // 断言: 加粗/斜体符号已去除
    expect(plain).toContain('状态: 正常运行');
    expect(plain).toContain('详情: 当前 CPU 负载 20%');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('`npm test`');
    expect(plain).toContain('npm test');
    // 断言: 链接展开
    expect(plain).toContain('官方文档 (https://deepseek.com)');
    // 断言: 代码块反引号去除
    expect(plain).not.toContain('```');
    expect(plain).toContain('pnpm run build');
    // 断言: 表格分隔符已被清理
    expect(plain).not.toContain('|---|---|');
  });
});

describe('契约测试: OutboundStreamBridge 静默与生命周期契约', () => {
  it('契约 3: start() 返回 no-op dispose 函数且不注册 session/event 监听', () => {
    let listened = false;
    const mockCtx: any = {
      on: (event: string) => {
        if (event === 'session/event') listened = true;
        return () => {};
      },
    };
    const bridge = new OutboundStreamBridge(mockCtx, {
      sessionManager: {} as any,
    });
    const stop = bridge.start();
    expect(typeof stop).toBe('function');
    expect(listened).toBe(false);
  });
});

