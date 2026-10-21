# dsh-napcat-bridge 文档

本项目是 DeepSeek Harness (DSH) 的 NapCat QQ 接入插件。插件通过 OneBot 11 协议对接 NapCat，为 DSH Agent 提供 QQ 群聊与私聊消息收发、上下文隔离、记忆读写与后台回顾等能力。

---

## 目录

- [快速上手 (getting-started.md)](getting-started.md)：环境要求、安装构建、反向 WebSocket 配置与连接验证。
- [系统架构 (architecture.md)](architecture.md)：插件生命周期、网关通信、会话管理、数据存储与记忆体系设计。
- [配置说明 (configuration.md)](configuration.md)：WebUI 配置项、默认值与参数功能说明。
- [工具与命令 (tools-and-commands.md)](tools-and-commands.md)：插件向 DSH 注册的 Agent 工具定义与 QQ 斜杠命令说明。
- [故障排查 (troubleshooting.md)](troubleshooting.md)：常见错误现象、排查方法与恢复步骤。

---

## 开发与归档日志

过程性文档（包括需求草案、Checklist、调研纪要、探查记录与阶段交付报告）存放于 [`devlog/`](../devlog/README.md)。
