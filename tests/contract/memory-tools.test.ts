/**
 * tests/contract/memory-tools.test.ts
 *
 * 契约测试: EN-003 3个核心 Memory Agent 工具 (read_memory, create_memory, edit_memory)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MemoryStorage } from '../../src/memory/storage.js';
import {
  MemoryTools,
  createMemoryToolDefinitions,
  resolveContextPeerAndQQ,
} from '../../src/memory/tools.js';

describe('契约测试: EN-003 Memory Agent 工具 (read_memory, create_memory, edit_memory)', () => {
  let tmpDir: string;
  let storage: MemoryStorage;
  let tools: MemoryTools;
  let emitMock: any;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-memtools-test-'));
    storage = new MemoryStorage(tmpDir);
    emitMock = vi.fn();
    tools = new MemoryTools(storage, { emit: emitMock } as any);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: read_memory 读取 session 规则与用户画像（不存在返回空串，不回退 default）', async () => {
    await storage.writeSessionMemory('group_3000000001', '群规：禁止水群');
    await storage.writeUserProfile('2000000001', '偏好：喜欢 Python 和 TS');

    // 1. 读已存在 session
    const resSession = await tools.readMemory({
      type: 'session',
      peer: 'group_3000000001',
    });
    expect(resSession.success).toBe(true);
    expect(resSession.type).toBe('session');
    expect(resSession.target).toBe('group_3000000001');
    expect(resSession.content).toBe('群规：禁止水群');
    expect(resSession.message).toBe('成功读取 Session 记忆 (group_3000000001)');

    // 2. 读已存在 user
    const resUser = await tools.readMemory({
      type: 'user',
      qq: '2000000001',
    });
    expect(resUser.success).toBe(true);
    expect(resUser.type).toBe('user');
    expect(resUser.target).toBe('2000000001');
    expect(resUser.content).toBe('偏好：喜欢 Python 和 TS');
    expect(resUser.message).toBe('成功读取用户画像 (2000000001)');

    // 3. 读不存在的 session -> 返回 content: ''，明确提示不存在或内容为空
    const resEmptySession = await tools.readMemory({
      type: 'session',
      peer: 'group_not_exist',
    });
    expect(resEmptySession.success).toBe(true);
    expect(resEmptySession.type).toBe('session');
    expect(resEmptySession.target).toBe('group_not_exist');
    expect(resEmptySession.content).toBe('');
    expect(resEmptySession.message).toBe('该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。');

    // 4. 读不存在的 user（即使 user/default.md 存在内容，也不回退 default.md）
    await storage.writeUserProfile('default', '默认兜底画像');
    const resEmptyUser = await tools.readMemory({
      type: 'user',
      qq: '2000000099',
    });
    expect(resEmptyUser.success).toBe(true);
    expect(resEmptyUser.type).toBe('user');
    expect(resEmptyUser.target).toBe('2000000099');
    expect(resEmptyUser.content).toBe('');
    expect(resEmptyUser.message).toBe('该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。');

    // 5. 验证 read_memory ToolDefinition 的 render 输出
    const toolDefs = createMemoryToolDefinitions(tools);
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;
    const renderFn = (readTool.output as any)?.render;
    expect(typeof renderFn).toBe('function');

    // 5.1 有内容分支渲染
    const renderedNotEmpty = renderFn({}, resSession);
    expect(renderedNotEmpty[0].text).toContain('成功读取 Session 记忆 (group_3000000001)');
    expect(renderedNotEmpty[0].text).toContain('群规：禁止水群');

    // 5.2 空文件分支渲染：明确引导使用 create_memory，绝不应显示"成功读取"
    const renderedEmpty = renderFn({}, resEmptySession);
    expect(renderedEmpty[0].text).toContain('该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。');
    expect(renderedEmpty[0].text).not.toContain('成功读取');

    // 5.3 若 message 为空，兜底落到「记忆内容为空（当前无内容）」
    const renderedFallback = renderFn({}, { content: '', message: '' });
    expect(renderedFallback[0].text).toContain('记忆内容为空');
    expect(renderedFallback[0].text).toContain('（当前无内容）');
    expect(renderedFallback[0].text).not.toContain('成功读取');

    // 6. 读内容全为空白的已存在文件 -> message 同样提示不存在或内容为空
    await fsp.writeFile(storage.getSessionMemoryPath('group_whitespace'), '   \n\t  \n', 'utf-8');
    const resWhitespace = await tools.readMemory({
      type: 'session',
      peer: 'group_whitespace',
    });
    expect(resWhitespace.success).toBe(true);
    expect(resWhitespace.message).toBe('该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。');
    const renderedWhitespace = renderFn({}, resWhitespace);
    expect(renderedWhitespace[0].text).toContain('该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。');
    expect(renderedWhitespace[0].text).not.toContain('成功读取');
  });

  it('契约 2: create_memory 仅当文件不存在时原样写入（无时间戳、无头），已存在时拒绝', async () => {
    // 1. session 首次创建
    const resSession = await tools.createMemory({
      type: 'session',
      peer: 'group_3000000001',
      content: '新增一条群规：提问请附带报错日志',
    });
    expect(resSession.success).toBe(true);
    expect(resSession.type).toBe('session');
    expect(resSession.target).toBe('group_3000000001');
    expect(emitMock).toHaveBeenCalledWith('memory/change', expect.objectContaining({
      type: 'session',
      peer: 'group_3000000001',
      action: 'create',
      content: '新增一条群规：提问请附带报错日志',
    }));

    // 验证原样写入磁盘：无 ISO 时间戳，无 # 自动头
    const sessionContent = await storage.readSessionMemory('group_3000000001');
    expect(sessionContent).toBe('新增一条群规：提问请附带报错日志');
    expect(sessionContent).not.toContain('# Session 记忆');

    // 2. 已存在时拒绝重复创建
    const resDup = await tools.createMemory({
      type: 'session',
      peer: 'group_3000000001',
      content: '尝试覆盖已有群规',
    });
    expect(resDup.success).toBe(false);
    expect(resDup.message).toBe('目标记忆已存在，请使用 edit_memory 修改，不要重复创建。');

    // 3. user 首次创建
    const resUser = await tools.createMemory({
      type: 'user',
      qq: '470250799',
      content: '偏好：经常使用 Linux 系统',
    });
    expect(resUser.success).toBe(true);
    expect(resUser.type).toBe('user');
    expect(resUser.target).toBe('470250799');
    expect(emitMock).toHaveBeenCalledWith('memory/change', expect.objectContaining({
      type: 'user',
      qq: '470250799',
      action: 'create',
    }));

    const userContent = await storage.readUserProfileRaw('470250799');
    expect(userContent).toBe('偏好：经常使用 Linux 系统');

    // 4. 内容为空时拒绝
    const resEmpty = await tools.createMemory({
      type: 'session',
      peer: 'group_empty',
      content: '   ',
    });
    expect(resEmpty.success).toBe(false);
    expect(resEmpty.message).toBe('创建内容不能为空。');
  });

  it('契约 3: edit_memory 定向字面替换与删除（old_string 唯一匹配、返回 preview）', async () => {
    // 准备初始文件
    await tools.createMemory({
      type: 'session',
      peer: 'group_edit_test',
      content: '前缀\n- 规则一：禁止灌水\n- 规则二：提问附日志\n- 规则三：文明发言\n后缀',
    });

    // 1. 唯一匹配替换 old_string -> new_string
    const resReplace = await tools.editMemory({
      type: 'session',
      peer: 'group_edit_test',
      old_string: '- 规则一：禁止灌水',
      new_string: '- 规则一：请专注技术讨论',
    });
    expect(resReplace.success).toBe(true);
    expect(resReplace.preview).toBeDefined();
    expect(resReplace.preview).toContain('- 规则一：请专注技术讨论');
    expect(resReplace.content).toBeUndefined(); // 不回全文
    expect(emitMock).toHaveBeenCalledWith('memory/change', expect.objectContaining({
      type: 'session',
      peer: 'group_edit_test',
      action: 'edit',
      old_string: '- 规则一：禁止灌水',
      new_string: '- 规则一：请专注技术讨论',
    }));

    const updatedContent = await storage.readSessionMemory('group_edit_test');
    expect(updatedContent).toContain('- 规则一：请专注技术讨论');
    expect(updatedContent).not.toContain('禁止灌水');

    // 2. new_string 为空或省略 -> 删除匹配片段
    const resDelete = await tools.editMemory({
      type: 'session',
      peer: 'group_edit_test',
      old_string: '\n- 规则三：文明发言',
      new_string: '',
    });
    expect(resDelete.success).toBe(true);
    const deletedContent = await storage.readSessionMemory('group_edit_test');
    expect(deletedContent).not.toContain('文明发言');
    expect(deletedContent).toContain('- 规则二：提问附日志');

    // 3. 省略 new_string -> 同样删除匹配片段
    const resOmit = await tools.editMemory({
      type: 'session',
      peer: 'group_edit_test',
      old_string: '前缀\n',
    });
    expect(resOmit.success).toBe(true);
    const omitContent = await storage.readSessionMemory('group_edit_test');
    expect(omitContent.startsWith('- 规则一：请专注技术讨论')).toBe(true);
  });

  it('契约 4: edit_memory 错误保护 - 未找到、多义、文件不存在、old_string 为空', async () => {
    await tools.createMemory({
      type: 'session',
      peer: 'group_err_test',
      content: 'apple banana apple cherry apple',
    });

    // 1. 未找到报错
    const resNotFound = await tools.editMemory({
      type: 'session',
      peer: 'group_err_test',
      old_string: 'pear',
      new_string: 'peach',
    });
    expect(resNotFound.success).toBe(false);
    expect(resNotFound.message).toBe('old_string 未在当前记忆中找到，可能内容已变化，请先 read_memory 获取最新内容。');

    // 2. 多义（出现 N 次）报错
    const resAmbiguous = await tools.editMemory({
      type: 'session',
      peer: 'group_err_test',
      old_string: 'apple',
      new_string: 'orange',
    });
    expect(resAmbiguous.success).toBe(false);
    expect(resAmbiguous.message).toBe('old_string 出现 3 次，请补充更多上下文使其唯一。');

    // 3. 文件不存在报错
    const resNotExists = await tools.editMemory({
      type: 'session',
      peer: 'group_non_existent',
      old_string: 'test',
      new_string: 'new_test',
    });
    expect(resNotExists.success).toBe(false);
    expect(resNotExists.message).toBe('目标记忆不存在，请先 create_memory 创建。');

    // 4. old_string 为空报错
    const resEmptyOld = await tools.editMemory({
      type: 'session',
      peer: 'group_err_test',
      old_string: '',
      new_string: 'something',
    });
    expect(resEmptyOld.success).toBe(false);
    expect(resEmptyOld.message).toBe('old_string 不能为空。');
  });

  it('契约 5: DSH ToolDefinitions 声明与执行上下文绑定', async () => {
    const toolDefs = createMemoryToolDefinitions(tools);
    expect(toolDefs.length).toBe(3);

    const names = toolDefs.map((t) => t.name);
    expect(names).toEqual(['read_memory', 'create_memory', 'edit_memory']);

    // 验证 resolveContextPeerAndQQ 上下文推导
    const execGroup = {
      agent: {
        userId: '2000000001',
        session: { id: 'qq-group-3000000001-1' },
      },
    };
    const resolvedGroup = resolveContextPeerAndQQ(execGroup);
    expect(resolvedGroup.peer).toBe('group_3000000001');
    expect(resolvedGroup.qq).toBe('2000000001');

    const execPrivate = {
      agent: {
        session: { id: 'qq-user-470250799-1' },
      },
    };
    const resolvedPrivate = resolveContextPeerAndQQ(execPrivate);
    expect(resolvedPrivate.peer).toBe('user_470250799');
    expect(resolvedPrivate.qq).toBe('470250799');

    // 验证 toolDef.execute
    const createTool = toolDefs.find((t) => t.name === 'create_memory')!;
    const createResult = await createTool.execute(
      { type: 'session', content: '测试群记忆' },
      execGroup as any
    );
    expect((createResult as any).success).toBe(true);

    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;
    const readResult = await readTool.execute({ type: 'session' }, execGroup as any);
    expect((readResult as any).success).toBe(true);
    expect((readResult as any).content).toBe('测试群记忆');

    const editTool = toolDefs.find((t) => t.name === 'edit_memory')!;
    const editResult = await editTool.execute(
      { type: 'session', old_string: '测试群记忆', new_string: '修改后的群记忆' },
      execGroup as any
    );
    expect((editResult as any).success).toBe(true);
    expect((editResult as any).preview).toContain('修改后的群记忆');
  });

  it('契约 6: Peer 映射与 default 会话校验 - 拒绝 default peer，显式传 peer 正确写入目标文件', async () => {
    const toolDefs = createMemoryToolDefinitions(tools);
    const createTool = toolDefs.find((t) => t.name === 'create_memory')!;
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;
    const editTool = toolDefs.find((t) => t.name === 'edit_memory')!;

    // 模拟来自 review-default-xxx 或无 peer 的上下文
    const execDefault = {
      agent: {
        session: { id: 'review-default-1788595929622' },
      },
    };

    // 1. 未显式传 peer 且上下文解析为 default 时被拦截拒绝
    const deniedRes = await createTool.execute(
      { type: 'session', content: '测试拒绝' },
      execDefault as any
    );
    expect((deniedRes as any).success).toBe(false);
    expect((deniedRes as any).message).toContain('请显式传入 peer 参数');

    // 2. 显式传入 peer='group_123456789' 时执行通过，且落盘到正确的文件
    const targetPeer = 'group_123456789';
    const allowedCreate = await createTool.execute(
      { type: 'session', peer: targetPeer, content: '由 review agent 显式指定 peer 写入' },
      execDefault as any
    );
    expect((allowedCreate as any).success).toBe(true);

    const targetContent = await storage.readSessionMemory(targetPeer);
    expect(targetContent).toBe('由 review agent 显式指定 peer 写入');

    // 3. edit 也支持显式传入 peer
    const allowedEdit = await editTool.execute(
      { type: 'session', peer: targetPeer, old_string: '指定 peer 写入', new_string: '修改成功' },
      execDefault as any
    );
    expect((allowedEdit as any).success).toBe(true);

    // 4. read 也支持显式传入 peer
    const readRes = await readTool.execute(
      { type: 'session', peer: targetPeer },
      execDefault as any
    );
    expect((readRes as any).success).toBe(true);
    expect((readRes as any).content).toContain('修改成功');

    // 检查绝不应该生成 review-*.md 文件
    const defaultPath = storage.getSessionMemoryPath('review-default-1788595929622');
    const defaultExists = await fsp.access(defaultPath).then(() => true).catch(() => false);
    expect(defaultExists).toBe(false);
  });

  it('契约 7: user 类型 peer 派生 qq 命中同一文件 (user/<qq>.md)', async () => {
    const targetQQ = '2415112980';
    const peer = `user_${targetQQ}`;

    // 1. 用 peer 派生 qq 首次创建（不显式传 qq）-> 正确落盘到 user/2415112980.md
    const createRes = await tools.createMemory({
      type: 'user',
      peer,
      content: '评测偏好：喜欢技术干货',
    });
    expect(createRes.success).toBe(true);
    expect(createRes.target).toBe(targetQQ);

    const profilePath = storage.getUserProfilePath(targetQQ);
    const profileExists = await fsp.access(profilePath).then(() => true).catch(() => false);
    expect(profileExists).toBe(true);

    // 2. 带 qq 的 edit 与用 peer 的 read 命中同一文件
    const editRes = await tools.editMemory({
      type: 'user',
      qq: targetQQ,
      old_string: '喜欢技术干货',
      new_string: '偏好代码实战',
    });
    expect(editRes.success).toBe(true);

    const readRes = await tools.readMemory({ type: 'user', peer });
    expect(readRes.success).toBe(true);
    expect(readRes.content).toBe('评测偏好：偏好代码实战');

    // 3. user/default.md 不应被误写
    const defaultPath = storage.getUserProfilePath('default');
    const defaultExists = await fsp.access(defaultPath).then(() => true).catch(() => false);
    expect(defaultExists).toBe(false);
  });

  it('契约 8: getPromptSnapshotSync 无头 session 记忆自动补充 ### 标题，已有 # 头原样保留', () => {
    // 1. 无头 session 内容 -> 注入时自动补充 ### Session 记忆（${peer}）
    storage.writeSessionMemorySync('group_test_headless', '群规：纯文本约定，无任何标题');
    const snapshotHeadless = storage.getPromptSnapshotSync('group_test_headless');
    expect(snapshotHeadless).toBe('### Session 记忆（group_test_headless）\n群规：纯文本约定，无任何标题');

    // 2. 已有 # 开头的内容 -> 原样保留，不重复补标题
    storage.writeSessionMemorySync('group_test_headed', '# 明确自定义标题\n群规：已有大标题');
    const snapshotHeaded = storage.getPromptSnapshotSync('group_test_headed');
    expect(snapshotHeaded).toBe('# 明确自定义标题\n群规：已有大标题');
    expect(snapshotHeaded).not.toContain('### Session 记忆');
  });

  it('契约 9: resolveContextPeerAndQQ 支持 review 会话映射回源 peer 与 QQ', () => {
    // 1. review 私聊会话 -> 映射回 user_<qq> 与 qq
    const resUser = resolveContextPeerAndQQ({
      agent: {
        session: { id: 'review-user_2415112980-1725600000000' },
      },
    });
    expect(resUser.peer).toBe('user_2415112980');
    expect(resUser.qq).toBe('2415112980');

    // 2. review 群聊会话 -> 映射回 group_<gid>，qq 保持 default
    const resGroup = resolveContextPeerAndQQ({
      agent: {
        session: { id: 'review-group_646988881-1725600000000' },
      },
    });
    expect(resGroup.peer).toBe('group_646988881');
    expect(resGroup.qq).toBe('default');

    // 3. 无法解析的 review id -> 回退 default
    const resDefault = resolveContextPeerAndQQ({
      agent: {
        session: { id: 'review-default-1788595929622' },
      },
    });
    expect(resDefault.peer).toBe('default');
    expect(resDefault.qq).toBe('default');

    const resInvalid = resolveContextPeerAndQQ({
      sessionId: 'review-invalid-session-format',
    });
    expect(resInvalid.peer).toBe('default');
    expect(resInvalid.qq).toBe('default');
  });

  it('契约 10: 写入端容量硬上限门禁 (user <= 1500, session <= 2200 超限拒绝并提示精简)', async () => {
    // 1. create_memory 超出 user 上限 (1500 字符)
    const longUserContent = 'A'.repeat(1501);
    const resOverUser = await tools.createMemory({
      type: 'user',
      qq: '123456789',
      content: longUserContent,
    });
    expect(resOverUser.success).toBe(false);
    expect(resOverUser.message).toContain('超出上限 (1500 字符)');
    expect(resOverUser.message).toContain('edit_memory 精简合并');
    expect(await storage.existsUserProfile('123456789')).toBe(false);

    // 2. create_memory 超出 session 上限 (2200 字符)
    const longSessionContent = 'B'.repeat(2201);
    const resOverSession = await tools.createMemory({
      type: 'session',
      peer: 'group_overflow',
      content: longSessionContent,
    });
    expect(resOverSession.success).toBe(false);
    expect(resOverSession.message).toContain('超出上限 (2200 字符)');
    expect(await storage.existsSessionMemory('group_overflow')).toBe(false);

    // 3. 上限内正常创建
    const normalUser = await tools.createMemory({
      type: 'user',
      qq: '123456789',
      content: '偏好：日常使用 Linux，喜欢简短回答',
    });
    expect(normalUser.success).toBe(true);

    // 4. edit_memory 替换后超出上限 -> 拒绝修改并保持原样
    const resEditOver = await tools.editMemory({
      type: 'user',
      qq: '123456789',
      old_string: '喜欢简短回答',
      new_string: 'C'.repeat(1500),
    });
    expect(resEditOver.success).toBe(false);
    expect(resEditOver.message).toContain('超出上限 (1500 字符)');
    const keptContent = await storage.readUserProfile('123456789');
    expect(keptContent).toContain('喜欢简短回答');
  });

  it('契约 11: 工具定义描述 (Tool Definitions) 包含 Compact、容量限制与禁流水账指导', () => {
    const toolDefs = createMemoryToolDefinitions(tools);
    const createTool = toolDefs.find((t) => t.name === 'create_memory')!;
    const editTool = toolDefs.find((t) => t.name === 'edit_memory')!;
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;

    // create_memory 描述
    expect(createTool.description).toContain('Compact');
    expect(createTool.description).toContain('1500');
    expect(createTool.description).toContain('2200');
    expect(createTool.description).toContain('严禁');

    // edit_memory 描述
    expect(editTool.description).toContain('Consolidation');
    expect(editTool.description).toContain('1500');
    expect(editTool.description).toContain('2200');

    // read_memory 描述
    expect(readTool.description).toContain('old_string');
  });
});

