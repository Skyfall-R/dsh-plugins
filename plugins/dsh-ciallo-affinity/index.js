// CialloAPI 会话粘性（dsh-ciallo-affinity）
//
// 给发往 Claude 的 /v1/messages 请求补上 metadata.user_id，内容为
//   {"device_id":"<设备名>","account_uuid":"","session_id":"<DSH 会话 id>"}
// 网关据此把同一会话固定到同一个上游账号，提示缓存不再因跨账号而整段重写。
//
// 流程：llm-pi-ai/request-headers 钩子把会话 id 放进内部请求头 → 本机中转读出它、写进请求体 → 转发上游。
// 子智能体（fork / spawn）默认归到根会话：fork 继承父会话的整段前缀，必须和父会话落在同一账号才能读到缓存。
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

const SESSION_HEADER = 'x-dsh-session-id';
const PURPOSE_HEADER = 'x-dsh-request-purpose';
const MAX_TRACKED = 50;

export const name = 'ciallo-affinity';

export function apply(ctx, config = {}) {
  const port = config.port ?? 18765;
  const upstream = new URL(config.upstream ?? 'https://cialloapi.com');
  const providers = new Set(config.providers ?? [config.provider ?? 'ciallo-anthropic']);
  const deviceId = config.deviceId || `dsh-${os.hostname()}`.toLowerCase();
  const subagents = config.subagents === 'own' ? 'own' : 'root';

  const stats = { requests: 0, injected: 0, kept: 0, noSession: 0, errors: 0, lastAt: null };
  const tracked = new Map(); // 会话 id → { root, depth, requests, lastAt }
  const rootCache = new Map();

  // 顺着 parentSession 找到根会话（只读内存里的会话头；查不到就用自身 id）
  function resolveRoot(id) {
    if (subagents === 'own') return { root: id, depth: 0 };
    const hit = rootCache.get(id);
    if (hit) return hit;
    const store = ctx.get?.('sessions');
    let cur = id, depth = 0;
    for (const seen = new Set([id]); depth < 16; depth++) {
      const parent = store?.get?.(cur)?.header?.parentSession;
      if (typeof parent !== 'string' || seen.has(parent)) break;
      seen.add(parent); cur = parent;
    }
    const result = { root: cur, depth };
    if (depth > 0 || store?.get?.(id)) rootCache.set(id, result);
    return result;
  }

  function track(id, root, depth) {
    const t = tracked.get(id) ?? { root, depth, requests: 0, lastAt: null };
    t.requests++; t.lastAt = new Date().toISOString(); t.root = root; t.depth = depth;
    tracked.delete(id); tracked.set(id, t);
    while (tracked.size > MAX_TRACKED) tracked.delete(tracked.keys().next().value);
  }

  // 1. 只给配置的路由加内部头；这些头只在本机中转里使用，转发前删除
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    if (providers.has(request.provider)) {
      if (request.sessionId) headers.set(SESSION_HEADER, String(request.sessionId));
      if (request.purpose) headers.set(PURPOSE_HEADER, String(request.purpose));
    }
    return next();
  });

  // 2. 本机中转
  const server = http.createServer((req, res) => {
    if (req.url === '/__ciallo-affinity') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ version: '1.1.0', port, upstream: upstream.origin, providers: [...providers], deviceId, subagents, ...stats,
        sessions: Object.fromEntries([...tracked].reverse()) }, null, 2));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      stats.requests++;
      let body = Buffer.concat(chunks);
      const sid = req.headers[SESSION_HEADER];
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'POST' && /\/v1\/messages$/.test(path) && body.length) {
        try {
          const json = JSON.parse(body.toString('utf8'));
          if (json.metadata?.user_id) stats.kept++;
          else if (typeof sid === 'string' && sid.length) {
            const { root, depth } = resolveRoot(sid);
            json.metadata = { ...(json.metadata ?? {}), user_id: JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: root }) };
            body = Buffer.from(JSON.stringify(json));
            stats.injected++; stats.lastAt = new Date().toISOString();
            track(sid, root, depth);
          } else stats.noSession++;
        } catch { /* 不是 JSON 就原样转发 */ }
      }
      const headers = { ...req.headers };
      delete headers[SESSION_HEADER]; delete headers[PURPOSE_HEADER]; delete headers.host; delete headers.connection;
      headers['content-length'] = String(body.length);
      const target = new URL(req.url ?? '/', upstream);
      const lib = target.protocol === 'http:' ? http : https;
      const up = lib.request(target, { method: req.method, headers }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      });
      up.on('error', (err) => {
        stats.errors++;
        ctx.logger?.warn?.(`ciallo-affinity: upstream error ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `ciallo-affinity relay: ${err.message}` } }));
      });
      res.on('close', () => { if (!res.writableFinished) up.destroy(); });
      up.end(body);
    });
  });
  server.keepAliveTimeout = 65_000;
  server.on('error', (err) => ctx.logger?.error?.(`ciallo-affinity: cannot listen on 127.0.0.1:${port}: ${err.message}`));
  server.listen(port, '127.0.0.1');
  ctx.on('dispose', () => { server.closeAllConnections?.(); server.close(); });
}
