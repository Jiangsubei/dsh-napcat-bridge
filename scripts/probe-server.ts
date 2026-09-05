/**
 * DSH NapCat OneBot 11 WebSocket Probe Server
 *
 * 最小 WebSocket 服务端探针，用于接收并保真记录 NapCat (OneBot 11) 推送的真实协议字段与事件。
 *
 * 用法:
 *   pnpm tsx scripts/probe-server.ts [--port 8080] [--host 0.0.0.0] [--token <token>] [--dir logs/probe]
 * 或通过环境变量:
 *   PORT=8080 TOKEN=mysecret pnpm tsx scripts/probe-server.ts
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

// ==================== 配置解析 ====================
function parseArgs(): { port: number; host: string; token: string; logDir: string } {
  const args = process.argv.slice(2);
  let port = Number(process.env.PORT || 8080);
  let host = process.env.HOST || '0.0.0.0';
  let token = process.env.TOKEN || '';
  let logDir = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs/probe');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[++i];
    } else if (args[i] === '--token' && args[i + 1]) {
      token = args[++i];
    } else if (args[i] === '--dir' && args[i + 1]) {
      logDir = path.resolve(process.cwd(), args[++i]);
    }
  }

  return { port, host, token, logDir };
}

const config = parseArgs();

// ==================== 日志文件初始化 ====================
if (!fs.existsSync(config.logDir)) {
  fs.mkdirSync(config.logDir, { recursive: true });
}

const jsonlPath = path.join(config.logDir, 'events.jsonl');
const humanLogPath = path.join(config.logDir, 'probe.log');

const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' });
const humanLogStream = fs.createWriteStream(humanLogPath, { flags: 'a' });

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'EVENT' | 'ACTION', msg: string, data?: unknown) {
  const now = new Date().toISOString();
  const line = `[${now}] [${level}] ${msg}`;
  
  // 控制台输出
  if (level === 'ERROR') {
    console.error('\x1b[31m%s\x1b[0m', line);
  } else if (level === 'WARN') {
    console.warn('\x1b[33m%s\x1b[0m', line);
  } else if (level === 'EVENT') {
    console.log('\x1b[36m%s\x1b[0m', line);
  } else if (level === 'ACTION') {
    console.log('\x1b[32m%s\x1b[0m', line);
  } else {
    console.log(line);
  }

  if (data !== undefined) {
    const formattedData = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    console.log(formattedData);
  }

  // 写入文本日志
  humanLogStream.write(line + (data !== undefined ? '\n' + (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) : '') + '\n');
}

function saveRawEvent(rawText: string, parsed: Record<string, unknown>) {
  const record = {
    received_at: new Date().toISOString(),
    timestamp_ms: Date.now(),
    event: parsed,
    raw_text: rawText,
  };
  jsonlStream.write(JSON.stringify(record) + '\n');
}

// ==================== HTTP & WebSocket 服务创建 ====================
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('DSH NapCat WebSocket Probe Server is running.\nConnect via OneBot 11 Reverse WebSocket.\n');
});

const wss = new WebSocketServer({ server });

let activeClients = 0;

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  activeClients++;
  const clientIp = req.socket.remoteAddress || 'unknown';
  const url = req.url || '/';
  const headers = req.headers;
  const selfId = headers['x-self-id'] || 'unknown';
  const clientRole = headers['x-client-role'] || 'Universal';
  const userAgent = headers['user-agent'] || 'unknown';

  log('INFO', `==================== 新客户端连接 ====================`);
  log('INFO', `客户端 IP: ${clientIp} | 路径: ${url}`);
  log('INFO', `OneBot Bot QQ (x-self-id): ${selfId} | 客户端角色: ${clientRole}`);
  log('INFO', `User-Agent: ${userAgent}`);

  // Token 鉴权校验 (若配置)
  if (config.token) {
    const authHeader = headers['authorization'] || '';
    const queryMatch = url.match(/[?&]access_token=([^&]+)/);
    const tokenInQuery = queryMatch ? queryMatch[1] : '';
    const tokenInHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();

    if (tokenInHeader !== config.token && tokenInQuery !== config.token) {
      log('WARN', `鉴权失败: Token 不匹配，正在拒绝连接`);
      ws.close(4001, 'Unauthorized');
      return;
    }
    log('INFO', `Token 鉴权通过`);
  }

  // 连上后自动发送查询版本与登录信息的 action
  try {
    const getVersionAction = JSON.stringify({
      action: 'get_version_info',
      params: {},
      echo: 'probe_get_version_info',
    });
    ws.send(getVersionAction);
    log('ACTION', `[Outbound] 发送探针指令: get_version_info`);

    const getLoginAction = JSON.stringify({
      action: 'get_login_info',
      params: {},
      echo: 'probe_get_login_info',
    });
    ws.send(getLoginAction);
    log('ACTION', `[Outbound] 发送探针指令: get_login_info`);
  } catch (err) {
    log('WARN', `发送探针初始指令失败: ${(err as Error).message}`);
  }

  // 接收消息处理
  ws.on('message', (data: Buffer | string) => {
    const rawText = data.toString('utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      log('WARN', `收到非 JSON 格式帧: ${rawText.slice(0, 100)}`);
      return;
    }

    // 记录全量原始事件到 jsonl
    saveRawEvent(rawText, parsed);

    // 解析事件类型并进行结构化摘要打印
    summarizeAndLogEvent(parsed);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    activeClients--;
    log('WARN', `客户端连接断开 (Code: ${code}, Reason: ${reason.toString() || 'None'}) | 剩余连接数: ${activeClients}`);
  });

  ws.on('error', (err: Error) => {
    log('ERROR', `WebSocket 发生错误: ${err.message}`);
  });
});

// ==================== 事件格式化摘要 ====================
function summarizeAndLogEvent(event: any) {
  // 1. Action 响应
  if (event.echo && event.status) {
    log('ACTION', `[Action 响应] Echo: ${event.echo} | Status: ${event.status} | Retcode: ${event.retcode}`, event.data);
    return;
  }

  const postType = event.post_type;

  // 2. Meta Event (心跳 / 生命周期)
  if (postType === 'meta_event') {
    const metaType = event.meta_event_type;
    if (metaType === 'heartbeat') {
      const status = event.status?.online ? 'Online' : 'StatusInfo';
      const interval = event.interval ? `${event.interval}ms` : '';
      log('INFO', `[Meta] ❤️ 心跳 (Heartbeat) | 状态: ${status} | 间隔: ${interval} | Self: ${event.self_id}`);
    } else if (metaType === 'lifecycle') {
      log('INFO', `[Meta] 🔄 生命周期 (Lifecycle) | SubType: ${event.sub_type} | Self: ${event.self_id}`);
    } else {
      log('INFO', `[Meta] 未知元事件 | Type: ${metaType}`, event);
    }
    return;
  }

  // 3. Message 事件 (群聊 / 私聊)
  if (postType === 'message' || postType === 'message_sent') {
    const isSent = postType === 'message_sent';
    const msgType = event.message_type; // 'group' | 'private'
    const subType = event.sub_type;     // 'normal' | 'friend' | 'group' | 'notice'
    const msgId = event.message_id;
    const userId = event.user_id;
    const groupId = event.group_id;
    const sender = event.sender || {};
    const nickname = sender.card || sender.nickname || 'Unknown';
    const rawMsg = event.raw_message || '';
    const segments = Array.isArray(event.message) ? event.message : [];

    const segmentTypes = segments.map((s: any) => s.type).join(', ') || 'text';
    const prefix = isSent ? '📤 [自身发出]' : '📥 [收到消息]';
    const peerDesc = msgType === 'group' ? `[群聊 ${groupId}]` : `[私聊]`;

    log('EVENT', `${prefix} ${peerDesc} [MsgId: ${msgId}] [QQ: ${userId} (${nickname})]\n      段类型: [${segmentTypes}]\n      原文: ${rawMsg}`);
    
    // 如果包含图片/文件/回复等特殊段，打印细节
    for (const seg of segments) {
      if (seg.type === 'image') {
        log('INFO', `   🖼️ [图片段] File: ${seg.data?.file} | SubType: ${seg.data?.subType ?? seg.data?.type ?? 'normal'} | URL: ${seg.data?.url?.slice(0, 80)}...`);
      } else if (seg.type === 'file') {
        log('INFO', `   📁 [文件段] Name: ${seg.data?.name} | Size: ${seg.data?.size} | FileId: ${seg.data?.file_id || seg.data?.file}`);
      } else if (seg.type === 'reply') {
        log('INFO', `   💬 [引用段] ReplyTo MsgId: ${seg.data?.id}`);
      } else if (seg.type === 'at') {
        log('INFO', `   🏷️ [At段] Target QQ: ${seg.data?.qq}`);
      } else if (seg.type === 'forward') {
        log('INFO', `   📦 [合并转发段] Forward ID: ${seg.data?.id}`);
      } else if (seg.type === 'shake') {
        log('INFO', `   📳 [窗口抖动段] Shake`);
      }
    }
    return;
  }

  // 4. Notice 事件 (撤回 / 戳一戳 / 文件上传 / 群成员变动)
  if (postType === 'notice') {
    const noticeType = event.notice_type;
    const subType = event.sub_type;
    const userId = event.user_id;
    const groupId = event.group_id;

    if (noticeType === 'group_recall' || noticeType === 'friend_recall') {
      log('EVENT', `[Notice] 🚫 [消息撤回] Peer: ${groupId ? `群 ${groupId}` : '私聊'} | 撤回 MsgId: ${event.message_id} | 操作者: ${event.operator_id || userId}`);
    } else if (noticeType === 'notify' && subType === 'poke') {
      log('EVENT', `[Notice] 👉 [戳一戳] Peer: ${groupId ? `群 ${groupId}` : '私聊'} | 发起人: ${userId} -> 目标: ${event.target_id}`);
    } else if (noticeType === 'group_upload') {
      log('EVENT', `[Notice] 📤 [群文件上传] 群: ${groupId} | 上传者: ${userId} | 文件:`, event.file);
    } else {
      log('EVENT', `[Notice] 🔔 [通知] Type: ${noticeType} | SubType: ${subType} | User: ${userId}`, event);
    }
    return;
  }

  // 5. Request 事件 (加好友 / 加群请求)
  if (postType === 'request') {
    const reqType = event.request_type;
    log('EVENT', `[Request] 🙋 [请求] Type: ${reqType} | User: ${event.user_id} | 附言: ${event.comment}`);
    return;
  }

  // 6. 其他未知事件
  log('EVENT', `[未知事件] PostType: ${postType}`, event);
}

// ==================== 启动监听 ====================
server.listen(config.port, config.host, () => {
  log('INFO', `========================================================`);
  log('INFO', `🚀 DSH NapCat 探针 WebSocket 服务端已启动!`);
  log('INFO', `   监听地址: ws://${config.host}:${config.port}`);
  log('INFO', `   鉴权 Token: ${config.token ? '已配置 (Bearer / access_token)' : '无 (开放连接)'}`);
  log('INFO', `   原始 JSONL 日志: ${jsonlPath}`);
  log('INFO', `   可读文本日志: ${humanLogPath}`);
  log('INFO', `========================================================`);
  log('INFO', `请在 NapCat 配置反向 WebSocket 地址: ws://<本机IP>:${config.port}`);
  log('INFO', `等待 NapCat 客户端连接并推送事件... (按 Ctrl+C 停止)`);
});

// 优雅退出处理
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  log('INFO', '正在关闭探针服务端...');
  wss.close(() => {
    server.close(() => {
      jsonlStream.end();
      humanLogStream.end();
      log('INFO', '探针服务已安全退出。');
      process.exit(0);
    });
  });
}
