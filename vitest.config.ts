import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 限制最大工作进程数为 CPU 核心数的 50%，避免跑满全部逻辑核心与争抢 Windows NTFS 文件锁
    maxWorkers: '50%',
    // 微内核真实装配测试（包含完整服务栈引导、NTFS Junction 链接与 SQLite/JSON 写入）较为繁重，放宽超时保护
    testTimeout: 15000,
    hookTimeout: 15000,
    teardownTimeout: 10000,
  },
});
