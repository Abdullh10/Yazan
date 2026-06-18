const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const q = require('./lib/queries');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ── SSE clients ──────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// ── helpers ──────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function getAuthUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const user = q.getSessionUser(token);
  if (!user || !user.active) return null;
  return user;
}

function userPublic(u) {
  return { id: u.id, name: u.name, role: u.role, stageId: u.stage_id, stageName: u.stage_name };
}

function scopeFor(user) {
  return { role: user.role, userId: user.id, stageId: user.stage_id };
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!filePath.startsWith(PUBLIC_DIR)) { send(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { send(res, 404, { error: 'not found' }); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  // SSE stream
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  try {
    // ── AUTH ──────────────────────────────────────────────
    if (pathname === '/api/login' && req.method === 'POST') {
      const { name, pin } = await readBody(req);
      const user = q.findUserByName(String(name || '').trim());
      if (!user || !user.active || !q.verifyPin(user, pin)) {
        return send(res, 401, { error: 'الاسم أو الرقم السري غير صحيح' });
      }
      const token = q.createSession(user.id);
      const full = q.getSessionUser(token);
      return send(res, 200, { token, user: userPublic(full) });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (token) q.deleteSession(token);
      return send(res, 200, { ok: true });
    }

    // everything below requires auth
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'يجب تسجيل الدخول' });

    if (pathname === '/api/me' && req.method === 'GET') {
      return send(res, 200, { user: userPublic(user) });
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      return send(res, 200, { warnSeconds: q.WARN_SECONDS, limitSeconds: q.LIMIT_SECONDS });
    }

    if (pathname === '/api/meta' && req.method === 'GET') {
      return send(res, 200, { stages: q.listStages() });
    }

    // ── EXITS ─────────────────────────────────────────────
    if (pathname === '/api/exits' && req.method === 'POST') {
      const { studentName, classId, reason } = await readBody(req);
      if (!studentName || !classId || !reason) return send(res, 400, { error: 'يرجى تعبئة جميع الحقول' });
      const cls = q.getClass(classId);
      if (!cls) return send(res, 400, { error: 'فصل غير صحيح' });
      if (q.findActiveDuplicate(studentName.trim(), classId)) {
        return send(res, 409, { error: 'هذا الطالب خارج الفصل بالفعل' });
      }
      const exit = q.createExit({ studentName: studentName.trim(), classId, reason, user });
      broadcast('exit_created', exit);
      return send(res, 201, { exit });
    }

    const returnMatch = pathname.match(/^\/api\/exits\/(\d+)\/return$/);
    if (returnMatch && req.method === 'POST') {
      const exit = q.returnExit(Number(returnMatch[1]));
      if (!exit) return send(res, 404, { error: 'غير موجود' });
      broadcast('exit_returned', exit);
      return send(res, 200, { exit });
    }

    if (pathname === '/api/exits/active' && req.method === 'GET') {
      return send(res, 200, { exits: q.listActiveExits(scopeFor(user)) });
    }

    if (pathname === '/api/exits/history' && req.method === 'GET') {
      return send(res, 200, { exits: q.listHistory(scopeFor(user)) });
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      const all = q.listAllForStats(scopeFor(user));
      return send(res, 200, { exits: all });
    }

    // ── ADMIN ─────────────────────────────────────────────
    if (pathname.startsWith('/api/admin/')) {
      if (user.role !== 'admin') return send(res, 403, { error: 'صلاحية مدير النظام فقط' });

      if (pathname === '/api/admin/stages' && req.method === 'GET') {
        return send(res, 200, { stages: q.listStages() });
      }
      if (pathname === '/api/admin/stages' && req.method === 'POST') {
        const { name, classCount } = await readBody(req);
        if (!name) return send(res, 400, { error: 'اسم المرحلة مطلوب' });
        const id = q.createStage(name.trim(), classCount);
        return send(res, 201, { id });
      }
      const stageMatch = pathname.match(/^\/api\/admin\/stages\/(\d+)$/);
      if (stageMatch && req.method === 'PUT') {
        const { name } = await readBody(req);
        q.renameStage(Number(stageMatch[1]), name.trim());
        return send(res, 200, { ok: true });
      }
      if (stageMatch && req.method === 'DELETE') {
        q.deleteStage(Number(stageMatch[1]));
        return send(res, 200, { ok: true });
      }
      const classesMatch = pathname.match(/^\/api\/admin\/stages\/(\d+)\/classes$/);
      if (classesMatch && req.method === 'POST') {
        const { label } = await readBody(req);
        if (!label) return send(res, 400, { error: 'اسم الفصل مطلوب' });
        const id = q.addClass(Number(classesMatch[1]), label.trim());
        return send(res, 201, { id });
      }
      const classMatch = pathname.match(/^\/api\/admin\/classes\/(\d+)$/);
      if (classMatch && req.method === 'DELETE') {
        q.deleteClass(Number(classMatch[1]));
        return send(res, 200, { ok: true });
      }

      if (pathname === '/api/admin/users' && req.method === 'GET') {
        return send(res, 200, { users: q.listUsers() });
      }
      if (pathname === '/api/admin/users' && req.method === 'POST') {
        const { name, role, stageId } = await readBody(req);
        if (!name || !role) return send(res, 400, { error: 'الاسم والدور مطلوبان' });
        if (!['admin', 'deputy', 'counselor', 'teacher'].includes(role)) {
          return send(res, 400, { error: 'دور غير صحيح' });
        }
        if (role === 'counselor' && !stageId) return send(res, 400, { error: 'يجب اختيار المرحلة للمرشد' });
        if (q.findUserByName(name.trim())) return send(res, 409, { error: 'يوجد مستخدم بهذا الاسم بالفعل' });
        const { id, pin } = q.createUser(name.trim(), role, stageId || null);
        return send(res, 201, { id, pin });
      }
      const resetMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/reset-pin$/);
      if (resetMatch && req.method === 'POST') {
        const pin = q.resetPin(Number(resetMatch[1]));
        return send(res, 200, { pin });
      }
      const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
      if (userMatch && req.method === 'PUT') {
        const { active } = await readBody(req);
        q.setUserActive(Number(userMatch[1]), active);
        return send(res, 200, { ok: true });
      }
      if (userMatch && req.method === 'DELETE') {
        q.deleteUser(Number(userMatch[1]));
        return send(res, 200, { ok: true });
      }
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'خطأ في الخادم' });
  }
});

server.listen(PORT, () => {
  console.log(`نظام الاستئذان الذكي يعمل على http://localhost:${PORT}`);
});
