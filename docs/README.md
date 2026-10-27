# dsh-napcat-bridge 文档

本项目是 DeepSeek Harness (DSH) 的 NapCat QQ 接入插件。插件通过 OneBot 11 协议对接 NapCat，为 DSH Agent 提供 QQ 群聊与私聊消息收发、专属预设隔离（`qq-session`）、用户侧静默出站体系、两层记忆体系与单 Agent 顺手提炼、表情包管理等能力。

---

## 目录

- [快速上手 (getting-started.md)](getting-started.md)：环境要求、安装构建、反向 WebSocket 配置与连接验证。
- [系统架构 (architecture.md)](architecture.md)：插件生命周期、单一真相源预设同步、出站静默原则、两层记忆体系与表情包存储设计。
- [配置说明 (configuration.md)](configuration.md)：WebUI 5 大 Tab 设置项、默认值、运行时配置说明与下线字段迁移指引。
- [工具与命令 (tools-and-commands.md)](tools-and-commands.md)：`qq-session` 预设隔离装配的 Agent 工具集定义与 QQ 斜杠命令说明。
- [故障排查 (troubleshooting.md)](troubleshooting.md)：常见问题现象（如出站静默未调用工具、预设工具隔离、表情包门控等）、排查方法与恢复步骤。

---

## 开发与归档日志

过程性文档（包括需求草案、Checklist、调研纪要、探查记录与阶段交付报告）存放于 [`devlog/`](../devlog/README.md)。
