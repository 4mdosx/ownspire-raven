'use strict';

// 局域网鉴权壳:登录页 + Cookie 会话,反向代理到容器内 127.0.0.1:3081 的 dsh,
// 并自动把 dsh 的 URL token 注入到上游请求(含 WebSocket)。

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const LISTEN_PORT = Number(process.env.PROXY_PORT || 3080);
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.DSH_PORT || 3081);
const TOKEN_FILE = process.env.DSH_TOKEN_FILE || '/run/dsh-token';
const COOKIE_NAME = 'wb_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USER = process.env.AUTH_USER || 'workbench';
const PASSWORD = process.env.AUTH_PASSWORD || '';
const SECRET = process.env.AUTH_SECRET || '';

if (!PASSWORD || !SECRET) {
  console.error('[auth-proxy] AUTH_PASSWORD / AUTH_SECRET 未注入,拒绝启动');
  process.exit(1);
}

const USER_HASH = crypto.createHash('sha256').update(USER).digest();
const PASSWORD_HASH = crypto.createHash('sha256').update(PASSWORD).digest();
const failures = new Map();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function cookieValue(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=');
  }
  return '';
}

function signSession() {
  const data = Buffer.from(JSON.stringify({
    user: USER,
    exp: Date.now() + SESSION_TTL_MS,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function readSession(req) {
  const cookie = cookieValue(req);
  if (!cookie) return null;
  const [data, sig] = cookie.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.user !== USER || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function getToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function loginPage(next, error) {
  const safeNext = escapeHtml(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
  const msg = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workbench 登录</title>
<style>
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f6f8;color:#1f2430;
 display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #e3e6ec;border-radius:12px;padding:32px;width:320px;box-shadow:0 8px 24px rgba(20,30,50,.06)}
h1{font-size:20px;margin:0 0 20px}label{display:block;margin:12px 0 4px;color:#52606d;font-size:13px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ccd3dd;border-radius:8px;font-size:15px}
button{width:100%;margin-top:20px;padding:11px;background:#2563eb;color:#fff;border:0;border-radius:8px;font-size:15px;cursor:pointer}
button:hover{background:#1d4ed8}.err{color:#c0392b;font-size:13px;margin:12px 0 0}
</style></head><body><div class="card"><h1>Workbench 登录</h1>
<form method="post" action="/login">
<input type="hidden" name="next" value="${safeNext}">
<label for="user">用户名</label><input id="user" name="user" autocomplete="username" required>
<label for="pass">密码</label><input id="pass" name="pass" type="password" autocomplete="current-password" required>
<button type="submit">登录</button>${msg}</form></div></body></html>`;
}

function rateLimited(ip) {
  const r = failures.get(ip);
  if (!r) return false;
  if (Date.now() > r.until) {
    failures.delete(ip);
    return false;
  }
  return r.count >= 10;
}

function recordFailure(ip) {
  const r = failures.get(ip) || { count: 0, until: Date.now() + 10 * 60 * 1000 };
  r.count += 1;
  failures.set(ip, r);
}

function upstreamHeaders(req) {
  const h = Object.assign({}, req.headers);
  h.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  // dsh 的 browser-trust fence 会校验 Origin;浏览器看到的是局域网地址,
  // 这里统一改写成上游 authority,避免每个访问地址都要配 DSH_TRUSTED_HOST
  if (h.origin) h.origin = `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  // 不转发 X-Forwarded-*:dsh 的 browser-trust/cookie 校验会拿它当外部 authority
  delete h['x-forwarded-host'];
  delete h['x-forwarded-proto'];
  delete h['x-forwarded-for'];
  if (h.cookie) {
    h.cookie = h.cookie
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith(`${COOKIE_NAME}=`))
      .join('; ');
    if (!h.cookie) delete h.cookie;
  }
  return h;
}

function hasDshCookie(req) {
  return /(^|;\s*)dsh-auth-/.test(req.headers.cookie || '');
}

// 用字符串处理而不是 URLSearchParams:dsh 前端用 "plugins/??a,b,c" 这种
// 双问号查询串预加载模块,URLSearchParams 会把整串重新编码,导致模块加载失败。
function withToken(reqUrl, token, dshCookiePresent) {
  const q = reqUrl.indexOf('?');
  const pathname = q === -1 ? reqUrl : reqUrl.slice(0, q);
  const search = q === -1 ? '' : reqUrl.slice(q + 1);
  const hasToken = /(^|&)token=/.test(search);

  // dsh 见到 token 就会重新认证并 303;已有 dsh Cookie 时不能再带 token
  if (dshCookiePresent) {
    if (!hasToken) return reqUrl;
    const kept = search.split('&').filter((p) => !p.startsWith('token='));
    return kept.length ? `${pathname}?${kept.join('&')}` : pathname;
  }
  if (!token || hasToken) return reqUrl;
  return `${pathname}?${search ? `${search}&` : ''}token=${token}`;
}

function handleLogin(req, res, url) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 16384) req.destroy();
  });
  req.on('end', () => {
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) return send(res, 429, '尝试次数过多,请 10 分钟后再试');

    const form = new URLSearchParams(body);
    const user = form.get('user') || '';
    const pass = form.get('pass') || '';
    const next = form.get('next') || '/';

    const uh = crypto.createHash('sha256').update(user).digest();
    const ph = crypto.createHash('sha256').update(pass).digest();
    const okUser = uh.length === USER_HASH.length && crypto.timingSafeEqual(uh, USER_HASH);
    const okPass = ph.length === PASSWORD_HASH.length && crypto.timingSafeEqual(ph, PASSWORD_HASH);

    if (!okUser || !okPass) {
      recordFailure(ip);
      return send(res, 200, loginPage(next, '用户名或密码错误'));
    }

    failures.delete(ip);
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    res.writeHead(303, {
      'Set-Cookie': `${COOKIE_NAME}=${signSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      Location: safeNext,
    });
    res.end();
  });
}

function forward(req, res, url) {
  const token = getToken();
  if (!token) return send(res, 503, 'dsh 尚未就绪:未获取到访问 token');
  const path = withToken(req.url, token, hasDshCookie(req));

  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path,
    headers: upstreamHeaders(req),
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    console.error('[auth-proxy] upstream error:', err.message);
    if (!res.headersSent) send(res, 502, 'Bad Gateway');
    else res.destroy();
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    console.error('[auth-proxy] 请求 URL 解析失败:', req.url, 'host=', req.headers.host, err.message);
    return send(res, 400, 'Bad Request');
  }

  if (url.pathname === '/login') {
    if (req.method === 'GET') return send(res, 200, loginPage(url.searchParams.get('next') || '/'));
    if (req.method === 'POST') return handleLogin(req, res, url);
    return send(res, 405, 'Method Not Allowed');
  }

  if (url.pathname === '/logout') {
    res.writeHead(303, {
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      Location: '/login',
    });
    return res.end();
  }

  if (url.pathname === '/healthz') {
    const ready = Boolean(getToken());
    return send(res, ready ? 200 : 503, ready ? 'ok' : 'token not ready');
  }

  if (!readSession(req)) {
    res.writeHead(303, { Location: `/login?next=${encodeURIComponent(req.url || '/')}` });
    return res.end();
  }

  forward(req, res, url);
});

server.on('upgrade', (req, socket, head) => {
  if (!readSession(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const token = getToken();
  if (!token) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const path = withToken(req.url, token, hasDshCookie(req));

  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: 'GET',
    path,
    headers: upstreamHeaders(req),
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    let raw = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      raw += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`;
    }
    socket.write(`${raw}\r\n`);
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[auth-proxy] listening on 0.0.0.0:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
