const crypto = require('node:crypto');
const { db, hashPin, genPin } = require('./db');

const WARN_SECONDS = 8 * 60;
const LIMIT_SECONDS = 10 * 60;

// ── Stages & classes ──────────────────────────────────────────
function listStages() {
  const stages = db.prepare('SELECT * FROM stages ORDER BY sort_order, id').all();
  return stages.map((s) => ({
    ...s,
    classes: db.prepare('SELECT * FROM classes WHERE stage_id = ? ORDER BY id').all(s.id),
  }));
}

function createStage(name, classCount) {
  db.prepare('INSERT INTO stages (name, sort_order) VALUES (?, (SELECT COALESCE(MAX(sort_order),-1)+1 FROM stages))').run(name);
  const stageId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  const n = Math.max(0, parseInt(classCount, 10) || 0);
  for (let i = 1; i <= n; i++) {
    db.prepare('INSERT INTO classes (stage_id, label) VALUES (?, ?)').run(stageId, `${i}`);
  }
  return stageId;
}

function renameStage(id, name) {
  db.prepare('UPDATE stages SET name = ? WHERE id = ?').run(name, id);
}

function deleteStage(id) {
  db.prepare('DELETE FROM classes WHERE stage_id = ?').run(id);
  db.prepare('DELETE FROM stages WHERE id = ?').run(id);
}

function addClass(stageId, label) {
  db.prepare('INSERT INTO classes (stage_id, label) VALUES (?, ?)').run(stageId, label);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

function deleteClass(id) {
  db.prepare('DELETE FROM classes WHERE id = ?').run(id);
}

function getClass(id) {
  return db.prepare(`
    SELECT c.*, s.name AS stage_name FROM classes c
    JOIN stages s ON s.id = c.stage_id
    WHERE c.id = ?
  `).get(id);
}

// ── Users ──────────────────────────────────────────────────────
function listUsers() {
  return db.prepare(`
    SELECT u.id, u.name, u.role, u.stage_id, s.name AS stage_name, u.active, u.created_at
    FROM users u LEFT JOIN stages s ON s.id = u.stage_id
    ORDER BY u.created_at DESC
  `).all();
}

function findUserByName(name) {
  return db.prepare('SELECT * FROM users WHERE name = ?').get(name);
}

function createUser(name, role, stageId) {
  const pin = genPin();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPin(pin, salt);
  db.prepare(
    'INSERT INTO users (name, role, stage_id, pin_salt, pin_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
  ).run(name, role, role === 'counselor' ? stageId : null, salt, hash, Date.now());
  const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  return { id, pin };
}

function resetPin(userId) {
  const pin = genPin();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPin(pin, salt);
  db.prepare('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hash, userId);
  return pin;
}

function setUserActive(userId, active) {
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, userId);
}

function deleteUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function verifyPin(user, pin) {
  const hash = hashPin(pin, user.pin_salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.pin_hash));
}

// ── Sessions ───────────────────────────────────────────────────
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  return token;
}

function getSessionUser(token) {
  const row = db.prepare(`
    SELECT u.*, s.name AS stage_name FROM sessions sess
    JOIN users u ON u.id = sess.user_id
    LEFT JOIN stages s ON s.id = u.stage_id
    WHERE sess.token = ?
  `).get(token);
  return row;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ── Exits ──────────────────────────────────────────────────────
function exitRowToObj(r) {
  return {
    id: r.id,
    studentName: r.student_name,
    classId: r.class_id,
    classLabel: r.class_label,
    stageId: r.stage_id,
    stageName: r.stage_name,
    reason: r.reason,
    initiatorName: r.initiator_name,
    initiatorRole: r.initiator_role,
    startTs: r.start_ts,
    returnTs: r.return_ts,
    duration: r.duration,
    status: r.status,
  };
}

const EXIT_SELECT = `
  SELECT e.*, c.label AS class_label, c.stage_id AS stage_id, s.name AS stage_name
  FROM exits e
  JOIN classes c ON c.id = e.class_id
  JOIN stages s ON s.id = c.stage_id
`;

function findActiveDuplicate(studentName, classId) {
  return db.prepare(`${EXIT_SELECT} WHERE e.status = 'active' AND e.student_name = ? AND e.class_id = ?`)
    .get(studentName, classId);
}

function createExit({ studentName, classId, reason, user }) {
  db.prepare(`
    INSERT INTO exits (student_name, class_id, reason, initiator_user_id, initiator_name, initiator_role, start_ts, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(studentName, classId, reason, user.id, user.name, user.role, Date.now());
  const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  return exitRowToObj(db.prepare(`${EXIT_SELECT} WHERE e.id = ?`).get(id));
}

function returnExit(id) {
  const row = db.prepare(`${EXIT_SELECT} WHERE e.id = ?`).get(id);
  if (!row || row.status !== 'active') return null;
  const returnTs = Date.now();
  const duration = Math.floor((returnTs - row.start_ts) / 1000);
  const status = duration > LIMIT_SECONDS ? 'late' : 'ontime';
  db.prepare('UPDATE exits SET return_ts = ?, duration = ?, status = ? WHERE id = ?')
    .run(returnTs, duration, status, id);
  return exitRowToObj(db.prepare(`${EXIT_SELECT} WHERE e.id = ?`).get(id));
}

function scopeClause(scope) {
  if (scope.role === 'admin' || scope.role === 'deputy') return { where: '1=1', params: [] };
  if (scope.role === 'counselor') return { where: 'c.stage_id = ?', params: [scope.stageId] };
  return { where: 'e.initiator_user_id = ?', params: [scope.userId] };
}

function listActiveExits(scope) {
  const { where, params } = scopeClause(scope);
  const rows = db.prepare(`${EXIT_SELECT} WHERE e.status = 'active' AND ${where} ORDER BY e.start_ts ASC`).all(...params);
  return rows.map(exitRowToObj);
}

function listHistory(scope, limit = 50) {
  const { where, params } = scopeClause(scope);
  const rows = db.prepare(`${EXIT_SELECT} WHERE e.status != 'active' AND ${where} ORDER BY e.return_ts DESC LIMIT ?`)
    .all(...params, limit);
  return rows.map(exitRowToObj);
}

function listAllForStats(scope) {
  const { where, params } = scopeClause(scope);
  const rows = db.prepare(`${EXIT_SELECT} WHERE ${where} ORDER BY e.start_ts DESC`).all(...params);
  return rows.map(exitRowToObj);
}

module.exports = {
  WARN_SECONDS,
  LIMIT_SECONDS,
  listStages,
  createStage,
  renameStage,
  deleteStage,
  addClass,
  deleteClass,
  getClass,
  listUsers,
  findUserByName,
  createUser,
  resetPin,
  setUserActive,
  deleteUser,
  verifyPin,
  createSession,
  getSessionUser,
  deleteSession,
  findActiveDuplicate,
  createExit,
  returnExit,
  listActiveExits,
  listHistory,
  listAllForStats,
};
