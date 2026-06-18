const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    label TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','deputy','counselor','teacher')),
    stage_id INTEGER REFERENCES stages(id),
    pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_name TEXT NOT NULL,
    class_id INTEGER NOT NULL REFERENCES classes(id),
    reason TEXT NOT NULL,
    initiator_user_id INTEGER NOT NULL REFERENCES users(id),
    initiator_name TEXT NOT NULL,
    initiator_role TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    return_ts INTEGER,
    duration INTEGER,
    status TEXT NOT NULL DEFAULT 'active'
  );
`);

function hashPin(pin, salt) {
  return crypto.pbkdf2Sync(String(pin), salt, 100000, 32, 'sha256').toString('hex');
}

function genPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function seed() {
  const stageCount = db.prepare('SELECT COUNT(*) AS c FROM stages').get().c;
  if (stageCount === 0) {
    const defaults = [
      { name: 'أول ثانوي', count: 7 },
      { name: 'ثاني ثانوي', count: 7 },
      { name: 'ثالث ثانوي', count: 6 },
    ];
    defaults.forEach((s, idx) => {
      db.prepare('INSERT INTO stages (name, sort_order) VALUES (?, ?)').run(s.name, idx);
      const stageId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      for (let i = 1; i <= s.count; i++) {
        db.prepare('INSERT INTO classes (stage_id, label) VALUES (?, ?)').run(stageId, `${idx + 1}/${i}`);
      }
    });
  }

  const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
  if (adminCount === 0) {
    const pin = genPin();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPin(pin, salt);
    db.prepare(
      'INSERT INTO users (name, role, stage_id, pin_salt, pin_hash, active, created_at) VALUES (?, ?, NULL, ?, ?, 1, ?)'
    ).run('مدير النظام', 'admin', salt, hash, Date.now());

    const msg = `\n==============================================\nتم إنشاء حساب مدير النظام الافتراضي:\n  الاسم: مدير النظام\n  الرقم السري: ${pin}\n  (يرجى تسجيل الدخول وحفظ هذا الرقم في مكان آمن)\n==============================================\n`;
    console.log(msg);
    fs.writeFileSync(path.join(__dirname, '..', 'ADMIN_CREDENTIALS.txt'), msg, 'utf8');
  }
}
seed();

module.exports = { db, hashPin, genPin };
