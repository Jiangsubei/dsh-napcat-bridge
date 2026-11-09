/**
 * dsh-napcat-bridge: 插件通用键值持久化仓库 (plugin_kv)
 */

export class KvRepository {
  constructor(private getDb: () => any) {}

  getPluginConfig(key: string): string | null {
    const db = this.getDb();
    const row = db.prepare(`SELECT value FROM plugin_kv WHERE key = ?`).get(key) as any;
    return row ? row.value : null;
  }

  setPluginConfig(key: string, value: string): void {
    const db = this.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO plugin_kv (key, value, updated_at) VALUES (?, ?, ?)
    `).run(key, value, Date.now());
  }
}
