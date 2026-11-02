import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { NapCatGatewayServer } from '../../src/gateway/server.js';

function noopLogger(): any {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

describe('契约测试: 网关 WebSocket 安全门控 (WS Host 环回绑定与 Token 强校验)', () => {
  let server: NapCatGatewayServer | null = null;
  let client: WebSocket | null = null;

  afterEach(async () => {
    if (client) {
      try {
        client.terminate();
      } catch {}
      client = null;
    }
    if (server) {
      try {
        await server.stop();
      } catch {}
      server = null;
    }
  });

  describe('1. WS 默认监听地址绑定契约', () => {
    it('未指定 host 时，默认且必须仅监听 127.0.0.1，绝不监听 0.0.0.0', async () => {
      server = new NapCatGatewayServer({
        port: 0,
        token: 'test-valid-token',
        logger: noopLogger(),
      });
      await server.start();
      const addr: any = (server as any).wss?.address();
      expect(addr).toBeDefined();
      expect(addr.address).toBe('127.0.0.1');
    });

    it('显式指定 host 时，尊重指定的主机绑定地址', async () => {
      server = new NapCatGatewayServer({
        host: '127.0.0.1',
        port: 0,
        token: 'test-valid-token',
        logger: noopLogger(),
      });
      await server.start();
      const addr: any = (server as any).wss?.address();
      expect(addr.address).toBe('127.0.0.1');
    });
  });

  describe('2. ws_token 强校验与空 Token 拒绝连接契约', () => {
    it('当服务端未配置 ws_token（留空）时，直接拒绝一切客户端连接 (401 Unauthorized)', async () => {
      server = new NapCatGatewayServer({
        port: 0,
        token: '', // 空 token
        logger: noopLogger(),
      });
      await server.start();
      const addr: any = (server as any).wss.address();

      let connectError: any = null;
      await new Promise<void>((resolve) => {
        client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
        client.once('open', () => {
          resolve();
        });
        client.once('error', (err) => {
          connectError = err;
          resolve();
        });
      });

      expect(connectError).toBeDefined();
      expect(connectError.message).toMatch(/401/);
    });

    it('当服务端配置了 ws_token 时，未携带 token 的客户端连接被拒绝 (401)', async () => {
      server = new NapCatGatewayServer({
        port: 0,
        token: 'my-super-secret-token',
        logger: noopLogger(),
      });
      await server.start();
      const addr: any = (server as any).wss.address();

      let connectError: any = null;
      await new Promise<void>((resolve) => {
        client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
        client.once('open', () => resolve());
        client.once('error', (err) => {
          connectError = err;
          resolve();
        });
      });

      expect(connectError).toBeDefined();
      expect(connectError.message).toMatch(/401/);
    });

    it('当客户端携带错误 token 时，连接被拒绝 (401)', async () => {
      server = new NapCatGatewayServer({
        port: 0,
        token: 'my-super-secret-token',
        logger: noopLogger(),
      });
      await server.start();
      const addr: any = (server as any).wss.address();

      let connectError: any = null;
      await new Promise<void>((resolve) => {
        client = new WebSocket(`ws://127.0.0.1:${addr.port}`, {
          headers: {
            Authorization: 'Bearer wrong-token',
          },
        });
        client.once('open', () => resolve());
        client.once('error', (err) => {
          connectError = err;
          resolve();
        });
      });

      expect(connectError).toBeDefined();
      expect(connectError.message).toMatch(/401/);
    });

    it('当客户端通过 Authorization Bearer 携带正确 token 时，握手成功并建立连接', async () => {
      server = new NapCatGatewayServer({
        port: 0,
        token: 'my-super-secret-token',
        logger: noopLogger(),
      });
      await server.start();
      const addr: any = (server as any).wss.address();

      let connected = false;
      await new Promise<void>((resolve, reject) => {
        client = new WebSocket(`ws://127.0.0.1:${addr.port}`, {
          headers: {
            Authorization: 'Bearer my-super-secret-token',
          },
        });
        client.once('open', () => {
          connected = true;
          resolve();
        });
        client.once('error', reject);
      });

      expect(connected).toBe(true);
      expect(server.isConnected).toBe(true);
    });

    it('当客户端通过 url query access_token 携带正确 token 时，握手成功并建立连接', async () => {
      server = new NapCatGatewayServer({
        port: 0,
        token: 'my-super-secret-token',
        logger: noopLogger(),
      });
      await server.start();
      const addr: any = (server as any).wss.address();

      let connected = false;
      await new Promise<void>((resolve, reject) => {
        client = new WebSocket(`ws://127.0.0.1:${addr.port}?access_token=my-super-secret-token`);
        client.once('open', () => {
          connected = true;
          resolve();
        });
        client.once('error', reject);
      });

      expect(connected).toBe(true);
      expect(server.isConnected).toBe(true);
    });
  });
});
