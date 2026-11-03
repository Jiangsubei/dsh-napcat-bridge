# 踩坑考证: DSH 工具 Lossless JSON 输出约束与 undefined 序列化红线

- **状态**: 已考证沉淀
- **日期**: 2026-11-02
- **关联提交**:
  - `cd2b848`: 清洗群成员工具输出符合DSH Lossless JSON约束杜绝undefined报错
  - `9c26493`: 解决 list_faces 无损JSON序列化异常、修复弹窗取消按钮折行挤压并补全巡检与过期清理接线
  - `e0f94e3`: 清洗黑话工具输出符合DSH Lossless JSON约束杜绝undefined报错

---

## 1. 现象与高欺骗性

在开发供 DSH（DeepSeek Harness）调用的 Agent 工具（通过 `defineTool` 声明）时，频繁遭遇以下运行时异常：

```text
Error: tool "<tool_name>" returned invalid output: value is not lossless JSON
```

### 极高欺骗性特征
该报错**并不代表底层业务没有执行**：
- 底层数据往往已经成功落库（例如 SQLite 记录已持久化写入、本地缓存文件已落盘、外部 HTTP 请求已成功响应）；
- 会话的动态提示词（Prompt Context）甚至已经读取到了最新写入的数据；
- 但当工具执行完毕将结果返回给 DSH 上下文时，DSH 微内核抛出上述异常，直接判定本次工具调用执行失败。
- **危害**：模型在后续对话中两眼抓瞎，发现工具执行报错但数据似乎又存在，极易引发自我怀疑、连续重复重试甚至上下文逻辑幻觉。

---

## 2. 根因机制考究

DSH 核心在处理 `defineTool` 的 `execute` 方法返回值时，底层通过 `snapshotJsonValue` 对返回结果进行无损 JSON 校验：
1. **严格 JSON 子集要求**：DSH 要求工具返回值必须能被无损（Lossless）地序列化与还原为合法的 JSON；
2. **JavaScript 对象的键值 `undefined` 陷阱**：
   - 在 TypeScript/JavaScript 中，为对象属性赋值 `undefined` 极其常见（如未赋值的可选字段 `{ evicted_term: undefined, error: undefined }`）；
   - 在原生 JSON 规范中不存在 `undefined` 类型；
   - DSH 的 `snapshotJsonValue` 校验器一旦在返回值对象中扫描到任何值为 `undefined` 的键（或函数、Symbol 等非原生类型），即视作数据“有损”，直接抛出 `value is not lossless JSON` 致命错误。

---

## 3. 解决方案与防范实践

### 3.1 深度清洗工具：`toLosslessJson`
在工具返回值进入 DSH 框架之前，统一通过 `toLosslessJson` 递归剥离所有值为 `undefined` 的字段：

```typescript
export function toLosslessJson<T>(val: T): T {
  if (val === undefined || val === null) return val;
  return JSON.parse(JSON.stringify(val));
}
```

在 `defineTool` 的 `execute` 中强制包裹：
```typescript
async execute(args, exec) {
  const res = await someToolLogic(args);
  return toLosslessJson(res) as any;
}
```

### 3.2 构造源头避免赋值 `undefined`
在业务逻辑构建结果对象时，可选属性优先采用 ES6 条件展开，从源头避免产生 `{ key: undefined }`：

```typescript
// ❌ 错误做法：未命中时会导致对象产生 { evicted_term: undefined }
return {
  success: true,
  evicted_term: res.evictedTerm,
};

// ✅ 正确做法：未命中时不创建该属性
return {
  success: true,
  ...(res.evictedTerm ? { evicted_term: res.evictedTerm } : {}),
};
```

### 3.3 契约测试必须编写 Lossless JSON 防御断言
任何新工具或重构工具的契约测试，必须包含专门的无损 JSON 断言用例：
```typescript
it('tool.execute 输出严格符合 DSH Lossless JSON 约束 (无任何 undefined 键)', async () => {
  const result = await (tool as any).execute({ ... });

  // 1. 遍历检查所有属性值绝无 undefined
  for (const [key, value] of Object.entries(result)) {
    expect(value).not.toBeUndefined();
  }

  // 2. 验证序列化幂等性
  expect(JSON.stringify(result)).toBe(JSON.stringify(JSON.parse(JSON.stringify(result))));
});
```
