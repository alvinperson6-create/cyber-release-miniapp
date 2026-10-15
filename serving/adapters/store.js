// 赛博放生 · 存储适配层（SQLite）
//
// 职责边界（阶段 3.1）：
// - 原始 SQL 与事务实现集中在本文件，其他模块不得直接写 SQL
// - workflow 不得绕过 commit/command 直接写表；queries 只获得只读能力
// - 所有写操作都是短事务；模型调用在事务外
//
// 数据路径（阶段 2）：
// 搬迁文件前必须把默认路径锚定到明确配置，而不是随 __dirname 漂移。
// 解析优先级：DB_PATH → CYBER_RELEASE_DB → 仓库根 server/data.db（历史位置）。
// 这样无论代码搬到哪个目录，历史数据都还在原处，不会"跟着文件搬家"而丢失。

const Database = require('better-sqlite3');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LEGACY_DB_PATH = path.join(REPO_ROOT, 'server', 'data.db');

/** 当前 schema 版本。新增迁移时 +1，绝不修改历史迁移内容。 */
const SCHEMA_VERSION = 2;

function resolveDbPath() {
  const explicit = process.env.DB_PATH || process.env.CYBER_RELEASE_DB;
  if (explicit) return path.resolve(explicit);
  return LEGACY_DB_PATH;
}

// ==================== 版本化迁移 ====================
//
// 约定：
// - 迁移只增不改：新增表/列/索引，不删除既有列，不重写历史数据
// - 可重入：每步先探测是否已应用（IF NOT EXISTS / PRAGMA table_info）
// - 新增审计字段允许历史缺值，不回填过去不存在的输入或决定
// - 加唯一约束前必须先核对历史重复（见 preflightUniqueIndex）

const MIGRATIONS = [
  {
    version: 1,
    name: 'journey_v2_core',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS creatures (
          id TEXT PRIMARY KEY,
          owner_key TEXT NOT NULL,
          species TEXT NOT NULL,
          origin_journey_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS journeys (
          id TEXT PRIMARY KEY,
          creature_id TEXT NOT NULL,
          owner_key TEXT NOT NULL,
          species TEXT NOT NULL,
          water TEXT NOT NULL,
          feeling TEXT NOT NULL,
          tone TEXT NOT NULL DEFAULT 'balanced',
          status TEXT NOT NULL DEFAULT 'preparing',
          pause_reason TEXT,
          goal TEXT,
          motivation_version INTEGER NOT NULL DEFAULT 0,
          state_version INTEGER NOT NULL DEFAULT 0,
          event_count INTEGER NOT NULL DEFAULT 0,
          ending_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_journeys_owner ON journeys(owner_key, created_at);

        CREATE TABLE IF NOT EXISTS motivations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journey_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          raw_text TEXT NOT NULL,
          status TEXT NOT NULL,
          items_json TEXT,
          note TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(journey_id, version)
        );

        CREATE TABLE IF NOT EXISTS encounters (
          id TEXT PRIMARY KEY,
          journey_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'proposed',
          proposal_json TEXT NOT NULL,
          facts_version INTEGER NOT NULL,
          state_version INTEGER NOT NULL,
          signal_message_id TEXT,
          signal_due_at INTEGER,
          supply_message_id TEXT,
          supply_late INTEGER NOT NULL DEFAULT 0,
          chosen_action TEXT,
          decision_source TEXT,
          decision_meta_json TEXT,
          outcome_json TEXT,
          outcome_status TEXT,
          reproposals INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(journey_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_encounters_journey ON encounters(journey_id, seq);

        CREATE TABLE IF NOT EXISTS facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journey_id TEXT NOT NULL,
          encounter_id TEXT,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          detail_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_facts_journey ON facts(journey_id, id);

        CREATE TABLE IF NOT EXISTS mechanism_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          creature_id TEXT NOT NULL,
          journey_id TEXT NOT NULL,
          encounter_id TEXT NOT NULL,
          pressure TEXT NOT NULL,
          dilemma TEXT NOT NULL,
          choice_cost TEXT NOT NULL,
          lasting_consequence TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cards_creature ON mechanism_cards(creature_id, id);

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          journey_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          encounter_id TEXT,
          text TEXT NOT NULL,
          title TEXT,
          meta_json TEXT,
          status TEXT NOT NULL DEFAULT 'sent',
          image TEXT,
          image_status TEXT,
          sent_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_journey ON messages(journey_id, sent_at);

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          journey_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          due_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          lease_until INTEGER,
          lease_key TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, due_at);

        CREATE TABLE IF NOT EXISTS model_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journey_id TEXT,
          task_id TEXT,
          kind TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          usage_json TEXT,
          latency_ms INTEGER,
          status TEXT NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_calls_journey ON model_calls(journey_id);

        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          owner_key TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    name: 'command_idempotency_and_operations',
    up(db) {
      // 命令幂等：同 owner + 同 operation + 同 requestId 只落一次业务结果。
      // 结果与业务变化在同一事务写入，因此重启后仍然有效。
      db.exec(`
        CREATE TABLE IF NOT EXISTS command_requests (
          owner_key TEXT NOT NULL,
          operation TEXT NOT NULL,
          request_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (owner_key, operation, request_id)
        );
      `);

      // 业务 operation 台账：把"是否已提交"变成数据库唯一约束，
      // 而不是"先查再插"的非原子去重。
      db.exec(`
        CREATE TABLE IF NOT EXISTS operations (
          operation_id TEXT PRIMARY KEY,
          journey_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          detail_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_operations_journey ON operations(journey_id, kind);
      `);

      // 任务去重：同一旅程 + 同一 kind + 同一业务目标只排一次。
      // reconcile 补任务时按此去重，避免崩溃恢复制造重复任务。
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_dedup (
          journey_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          goal_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (journey_id, kind, goal_key)
        );
      `);

      // model_calls 增加审计维度（阶段 D：telemetry 至少关联
      // request/journey/encounter/task/operation）。全部允许历史缺值。
      if (!hasColumn(db, 'model_calls', 'operation_id')) {
        db.exec(`ALTER TABLE model_calls ADD COLUMN operation_id TEXT`);
      }
      if (!hasColumn(db, 'model_calls', 'encounter_id')) {
        db.exec(`ALTER TABLE model_calls ADD COLUMN encounter_id TEXT`);
      }
      if (!hasColumn(db, 'model_calls', 'attempt')) {
        db.exec(`ALTER TABLE model_calls ADD COLUMN attempt INTEGER`);
      }
      if (!hasColumn(db, 'model_calls', 'operation_kind')) {
        db.exec(`ALTER TABLE model_calls ADD COLUMN operation_kind TEXT`);
      }
    }
  }
];

function hasColumn(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
  return cols.some(c => c.name === column);
}

function currentVersion(db) {
  try {
    return db.pragma('user_version', { simple: true }) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 加唯一索引前的历史重复核对。
 * 有重复就明确失败，绝不通过删历史记录让迁移"通过"。
 */
function preflightUniqueIndex(db, table, columns, indexName) {
  const dup = db.prepare(`
    SELECT ${columns.join(', ')}, COUNT(*) AS c
    FROM "${table}" GROUP BY ${columns.join(', ')} HAVING c > 1 LIMIT 5
  `).all();
  if (dup.length) {
    throw new Error(
      `迁移中止：${table}(${columns.join(',')}) 存在历史重复，无法加唯一索引 ${indexName}。` +
      `示例：${JSON.stringify(dup)}。请人工核对后再迁移，不要删除历史记录。`
    );
  }
}

function runMigrations(db, log = () => {}) {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > from).sort((a, b) => a.version - b.version);
  if (!pending.length) return { from, to: from, applied: [] };
  const applied = [];
  for (const m of pending) {
    const tx = db.transaction(() => m.up(db));
    tx();
    db.pragma(`user_version = ${m.version}`);
    applied.push(m.name);
    log(`migration v${m.version} (${m.name}) applied`);
  }
  return { from, to: currentVersion(db), applied };
}

// ==================== Store 实例 ====================
//
// 阶段 B 的硬要求：两个 runtime 的库互不污染。
// 因此这里不是模块级单例，而是 createStore() 工厂：每个实例持有自己的
// 连接与路径，close() 只关自己那份。
// 纯函数（迁移定义、路径解析）留在模块级，不含 IO 状态。

function createStore(opts = {}) {
  let db = null;
  let dbPath = null;
  const defaultPath = opts.path ? path.resolve(opts.path) : null;

  function initDb(initOpts = {}) {
    closeDb();
    const target = initOpts.path ? path.resolve(initOpts.path) : (defaultPath || resolveDbPath());
    db = new Database(target);
    dbPath = target;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const result = runMigrations(db, initOpts.log || (() => {}));
    return { db, path: target, migration: result };
  }

  function getDb() {
    if (!db) initDb();
    return db;
  }

  function getDbPath() {
    return dbPath || defaultPath || resolveDbPath();
  }

  function closeDb() {
    if (db) {
      try { db.close(); } catch (e) { /* already closed */ }
      db = null;
      dbPath = null;
    }
  }

  function rid(prefix) {
    return `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(5).toString('base64url')}`;
  }

// ==================== 会话 ====================
function upsertSession(tokenHash, ownerKey, now) {
  getDb().prepare(`
    INSERT INTO sessions (token_hash, owner_key, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(tokenHash, ownerKey, now, now);
}

function getSessionByTokenHash(tokenHash) {
  return getDb().prepare(`SELECT * FROM sessions WHERE token_hash = ?`).get(tokenHash) || null;
}

// ==================== 生物与旅程 ====================
function createCreature({ id, ownerKey, species, originJourneyId, now }) {
  getDb().prepare(`
    INSERT INTO creatures (id, owner_key, species, origin_journey_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, ownerKey, species, originJourneyId || null, now, now);
  return getCreature(id);
}

function getCreature(id) {
  return getDb().prepare(`SELECT * FROM creatures WHERE id = ?`).get(id) || null;
}

function getCreaturesByOwner(ownerKey) {
  return getDb().prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM journeys j WHERE j.creature_id = c.id) AS journey_count
    FROM creatures c WHERE c.owner_key = ? ORDER BY c.created_at ASC
  `).all(ownerKey);
}

function getOwnedCreature(id, ownerKey) {
  return getDb().prepare(`SELECT * FROM creatures WHERE id = ? AND owner_key = ?`).get(id, ownerKey) || null;
}

function createJourney({ id, creatureId, ownerKey, species, water, feeling, tone, now }) {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare(`
      INSERT INTO journeys (id, creature_id, owner_key, species, water, feeling, tone, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
    `).run(id, creatureId, ownerKey, species, water, feeling, tone || 'balanced', now, now);
    // 本程动机档案 v1：先持久化原文，识别状态 pending（后台补齐）
    d.prepare(`
      INSERT INTO motivations (journey_id, version, raw_text, status, created_at)
      VALUES (?, 1, ?, 'pending', ?)
    `).run(id, feeling, now);
  });
  tx();
  return getJourney(id);
}

function getJourney(id) {
  return getDb().prepare(`SELECT * FROM journeys WHERE id = ?`).get(id) || null;
}

function getOwnedJourney(id, ownerKey) {
  return getDb().prepare(`SELECT * FROM journeys WHERE id = ? AND owner_key = ?`).get(id, ownerKey) || null;
}

function getJourneysByOwner(ownerKey) {
  return getDb().prepare(`SELECT * FROM journeys WHERE owner_key = ? ORDER BY created_at DESC`).all(ownerKey);
}

function getActiveJourneys(limit = 50) {
  return getDb().prepare(`
    SELECT * FROM journeys WHERE status IN ('preparing', 'active') ORDER BY created_at ASC LIMIT ?
  `).all(limit);
}

function countJourneysByCreature(creatureId) {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM journeys WHERE creature_id = ?`).get(creatureId).c;
}

/** 条件更新：乐观锁。expected 里的字段必须与库内一致才生效 */
function updateJourney(id, fields, expected = {}) {
  const all = { ...fields, updated_at: fields.updated_at ?? Date.now() };
  const keys = Object.keys(all);
  if (!keys.length) return false;
  const conds = ['id = @id'];
  const params = { id };
  const sets = [];
  for (const k of keys) {
    params[`f_${k}`] = all[k];
    sets.push(`${k} = @f_${k}`);
  }
  for (const [k, v] of Object.entries(expected)) {
    if (v === null) { conds.push(`${k} IS NULL`); continue; }
    conds.push(`${k} = @e_${k}`);
    params[`e_${k}`] = v;
  }
  const info = getDb().prepare(
    `UPDATE journeys SET ${sets.join(', ')} WHERE ${conds.join(' AND ')}`
  ).run(params);
  return info.changes > 0;
}

function endJourneyByUser(id, now) {
  const info = getDb().prepare(`
    UPDATE journeys SET status = 'ended_user', ending_reason = 'user', updated_at = ?
    WHERE id = ? AND status IN ('preparing', 'active', 'paused')
  `).run(now, id);
  return info.changes > 0;
}

function updateTone(id, tone) {
  return updateJourney(id, { tone }, {});
}

// ==================== 动机档案 ====================
function saveMotivation(journeyId, version, { status, items, note, now }) {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare(`
      UPDATE motivations SET status = ?, items_json = ?, note = ?
      WHERE journey_id = ? AND version = ?
    `).run(status, items ? JSON.stringify(items) : null, note || null, journeyId, version);
    d.prepare(`UPDATE journeys SET motivation_version = ?, updated_at = ? WHERE id = ?`)
      .run(version, now, journeyId);
  });
  tx();
  return getMotivation(journeyId, version);
}

function getMotivation(journeyId, version) {
  const row = version
    ? getDb().prepare(`SELECT * FROM motivations WHERE journey_id = ? AND version = ?`).get(journeyId, version)
    : getDb().prepare(`SELECT * FROM motivations WHERE journey_id = ? ORDER BY version DESC LIMIT 1`).get(journeyId);
  if (!row) return null;
  let items = null;
  try { items = row.items_json ? JSON.parse(row.items_json) : null; } catch (e) { items = null; }
  return {
    id: row.id, journeyId: row.journey_id, version: row.version, rawText: row.raw_text,
    status: row.status, items, note: row.note, createdAt: row.created_at
  };
}

// ==================== 遭遇 ====================
function insertEncounter({ id, journeyId, seq, proposal, factsVersion, stateVersion, now }) {
  getDb().prepare(`
    INSERT INTO encounters (id, journey_id, seq, status, proposal_json, facts_version, state_version, created_at, updated_at)
    VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?)
  `).run(id, journeyId, seq, JSON.stringify(proposal), factsVersion, stateVersion, now, now);
  return getEncounter(id);
}

function getEncounter(id) {
  const row = getDb().prepare(`SELECT * FROM encounters WHERE id = ?`).get(id);
  return row ? shapeEncounter(row) : null;
}

function getEncounterBySeq(journeyId, seq) {
  const row = getDb().prepare(`SELECT * FROM encounters WHERE journey_id = ? AND seq = ?`).get(journeyId, seq);
  return row ? shapeEncounter(row) : null;
}

function getEncounters(journeyId) {
  return getDb().prepare(`SELECT * FROM encounters WHERE journey_id = ? ORDER BY seq ASC`).all(journeyId).map(shapeEncounter);
}

function getLatestEncounter(journeyId) {
  const row = getDb().prepare(`SELECT * FROM encounters WHERE journey_id = ? ORDER BY seq DESC LIMIT 1`).get(journeyId);
  return row ? shapeEncounter(row) : null;
}

/**
 * 按信号消息 ID 查它所属的遭遇（阶段 C.3：回复必须显式给目标，
 * 不能靠"取最新遭遇"猜测）。
 */
function getEncounterBySignalMessageId(journeyId, messageId) {
  const row = getDb().prepare(
    `SELECT * FROM encounters WHERE journey_id = ? AND signal_message_id = ? LIMIT 1`
  ).get(journeyId, messageId);
  return row ? shapeEncounter(row) : null;
}

function shapeEncounter(row) {
  let proposal = null;
  try { proposal = JSON.parse(row.proposal_json); } catch (e) { proposal = null; }
  let outcome = null;
  try { outcome = row.outcome_json ? JSON.parse(row.outcome_json) : null; } catch (e) { outcome = null; }
  let decisionMeta = null;
  try { decisionMeta = row.decision_meta_json ? JSON.parse(row.decision_meta_json) : null; } catch (e) { decisionMeta = null; }
  return {
    id: row.id, journeyId: row.journey_id, seq: row.seq, status: row.status,
    proposal, factsVersion: row.facts_version, stateVersion: row.state_version,
    signalMessageId: row.signal_message_id, signalDueAt: row.signal_due_at,
    supplyMessageId: row.supply_message_id, supplyLate: !!row.supply_late,
    chosenAction: row.chosen_action, decisionSource: row.decision_source,
    decisionMeta, outcome, outcomeStatus: row.outcome_status,
    reproposals: row.reproposals,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function freezeEncounterSignal(id, { messageId, dueAt, now }) {
  const info = getDb().prepare(`
    UPDATE encounters SET status = 'signal_sent', signal_message_id = ?, signal_due_at = ?, updated_at = ?
    WHERE id = ? AND status = 'proposed'
  `).run(messageId, dueAt, now, id);
  return info.changes > 0;
}

function attachSupply(id, messageId, now) {
  const info = getDb().prepare(`
    UPDATE encounters SET supply_message_id = ?, updated_at = ?
    WHERE id = ? AND status = 'signal_sent' AND supply_message_id IS NULL
  `).run(messageId, now, id);
  return info.changes > 0;
}

/**
 * 决策落账（阶段 D：提交前复核输入快照）。
 *
 * expectedSupplyMessageId 用于"新增按时补给不能被旧的无补给决策悄悄吞掉"：
 * 生成决策时的补给位必须仍然一致，否则判 stale 丢弃重算。
 */
function decideEncounter(id, { action, source, meta, now, expectSupply = undefined, expectStateVersion = undefined }) {
  const conds = [`id = @id`, `status IN ('proposed', 'signal_sent')`];
  const params = { id, chosen_action: action, decision_source: source, decision_meta_json: meta ? JSON.stringify(meta) : null, updated_at: now };
  if (expectSupply !== undefined) {
    if (expectSupply === null) { conds.push(`supply_message_id IS NULL`); }
    else { conds.push(`supply_message_id = @expectSupply`); params.expectSupply = expectSupply; }
  }
  if (expectStateVersion !== undefined) {
    conds.push(`state_version = @expectStateVersion`);
    params.expectStateVersion = expectStateVersion;
  }
  const info = getDb().prepare(`
    UPDATE encounters SET status = 'decided', chosen_action = @chosen_action,
      decision_source = @decision_source, decision_meta_json = @decision_meta_json, updated_at = @updated_at
    WHERE ${conds.join(' AND ')}
  `).run(params);
  return info.changes > 0;
}

function resolveEncounter(id, { outcome, outcomeStatus, stateVersion, now }) {
  const info = getDb().prepare(`
    UPDATE encounters SET status = 'resolved', outcome_json = ?, outcome_status = ?, state_version = ?, updated_at = ?
    WHERE id = ? AND status = 'decided'
  `).run(JSON.stringify(outcome), outcomeStatus || 'ok', stateVersion, now, id);
  return info.changes > 0;
}

function markEncounterStatus(id, status, now) {
  const info = getDb().prepare(`UPDATE encounters SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, id);
  return info.changes > 0;
}

function reproposalEncounter(id, { proposal, stateVersion, now }) {
  const info = getDb().prepare(`
    UPDATE encounters SET proposal_json = ?, state_version = ?, reproposals = reproposals + 1,
      status = 'proposed', updated_at = ?
    WHERE id = ? AND status = 'proposed'
  `).run(JSON.stringify(proposal), stateVersion, now, id);
  return info.changes > 0;
}

/** 只读查询：给 queries 用，不暴露写接口 */
function readResolvedProposals(journeyId, limit = 6) {
  return getDb().prepare(`
    SELECT proposal_json FROM encounters WHERE journey_id = ? AND status = 'resolved' ORDER BY seq DESC LIMIT ?
  `).all(journeyId, limit).map(r => {
    let proposal = null;
    try { proposal = JSON.parse(r.proposal_json); } catch (e) { proposal = null; }
    return { proposal };
  });
}

function readLastResolved(journeyId) {
  const row = getDb().prepare(
    `SELECT * FROM encounters WHERE journey_id = ? AND status = 'resolved' ORDER BY seq DESC LIMIT 1`
  ).get(journeyId);
  if (!row) return null;
  let proposal = null;
  try { proposal = JSON.parse(row.proposal_json); } catch (e) { proposal = null; }
  return { id: row.id, title: proposal?.title || null };
}

function readJourneysByCreature(creatureId) {
  return getDb().prepare(`SELECT id, status, created_at FROM journeys WHERE creature_id = ? ORDER BY created_at DESC`).all(creatureId);
}

/** 公共脉搏：只返回累计数与水域/时间，绝不暴露原话 */
function readPublicPulse(limit = 12) {
  const d = getDb();
  return {
    total: d.prepare(`SELECT COUNT(*) AS c FROM journeys`).get().c,
    recent: d.prepare(`SELECT water, created_at FROM journeys ORDER BY created_at DESC LIMIT ?`).all(limit)
      .map(r => ({ water: r.water, ts: r.created_at }))
  };
}

// ==================== 事实账本 ====================
function insertFacts(journeyId, encounterId, seq, facts, now) {
  const stmt = getDb().prepare(`
    INSERT INTO facts (journey_id, encounter_id, seq, kind, content, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = getDb().transaction((items) => {
    for (const f of items) {
      stmt.run(journeyId, encounterId, seq, f.kind, String(f.content).slice(0, 500), f.detail ? JSON.stringify(f.detail) : null, now);
    }
  });
  tx(facts || []);
}

function getFacts(journeyId, { upToSeq } = {}) {
  const rows = upToSeq == null
    ? getDb().prepare(`SELECT * FROM facts WHERE journey_id = ? ORDER BY id ASC`).all(journeyId)
    : getDb().prepare(`SELECT * FROM facts WHERE journey_id = ? AND seq <= ? ORDER BY id ASC`).all(journeyId, upToSeq);
  return rows.map(r => {
    let detail = null;
    try { detail = r.detail_json ? JSON.parse(r.detail_json) : null; } catch (e) { detail = null; }
    return { id: r.id, journeyId: r.journey_id, encounterId: r.encounter_id, seq: r.seq, kind: r.kind, content: r.content, detail, createdAt: r.created_at };
  });
}

// ==================== 机制卡 ====================
function insertMechanismCard({ creatureId, journeyId, encounterId, card, now }) {
  getDb().prepare(`
    INSERT INTO mechanism_cards (creature_id, journey_id, encounter_id, pressure, dilemma, choice_cost, lasting_consequence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(creatureId, journeyId, encounterId,
    String(card.pressure || '').slice(0, 300), String(card.dilemma || '').slice(0, 300),
    String(card.choice_cost || '').slice(0, 300), String(card.lasting_consequence || '').slice(0, 300), now);
}

function getRecentCards(creatureId, limit = 3) {
  return getDb().prepare(`SELECT * FROM mechanism_cards WHERE creature_id = ? ORDER BY id DESC LIMIT ?`).all(creatureId, limit);
}

// ==================== 消息 ====================
function insertMessage({ id, journeyId, kind, encounterId, text, title, meta, status, image, imageStatus, sentAt, now }) {
  getDb().prepare(`
    INSERT INTO messages (id, journey_id, kind, encounter_id, text, title, meta_json, status, image, image_status, sent_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, journeyId, kind, encounterId || null, text, title || null,
    meta ? JSON.stringify(meta) : null, status || 'sent', image || null, imageStatus || null, sentAt ?? now, now);
  return getMessage(id);
}

function getMessage(id) {
  const row = getDb().prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
  return row ? shapeMessage(row) : null;
}

function shapeMessage(row) {
  let meta = null;
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch (e) { meta = null; }
  return {
    id: row.id, journeyId: row.journey_id, kind: row.kind, encounterId: row.encounter_id,
    text: row.text, title: row.title, meta, status: row.status,
    image: row.image, imageStatus: row.image_status, sentAt: row.sent_at, createdAt: row.created_at
  };
}

function getMessages(journeyId) {
  return getDb().prepare(`SELECT * FROM messages WHERE journey_id = ? ORDER BY sent_at ASC, id ASC`)
    .all(journeyId).map(shapeMessage);
}

function lastUserFacingAt(journeyId) {
  const row = getDb().prepare(`
    SELECT MAX(sent_at) AS t FROM messages
    WHERE journey_id = ? AND kind IN ('signal', 'letter', 'final_letter')
  `).get(journeyId);
  return row?.t || null;
}

function setMessagesStatusByEncounter(encounterId, status) {
  getDb().prepare(`UPDATE messages SET status = ? WHERE encounter_id = ? AND kind = 'signal'`).run(status, encounterId);
}

function attachMessageImage(id, image, imageStatus) {
  getDb().prepare(`UPDATE messages SET image = ?, image_status = ? WHERE id = ?`).run(image, imageStatus, id);
}

// ==================== 任务队列 ====================
function insertTask({ id, journeyId, kind, dueAt, payload, now }) {
  getDb().prepare(`
    INSERT INTO tasks (id, journey_id, kind, due_at, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(id, journeyId, kind, dueAt, payload ? JSON.stringify(payload) : null, now, now);
  return id;
}

function getTask(id) {
  return getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) || null;
}

function hasOpenTask(journeyId, kind) {
  return !!getDb().prepare(`
    SELECT 1 FROM tasks WHERE journey_id = ? AND kind = ? AND status IN ('pending', 'leased') LIMIT 1
  `).get(journeyId, kind);
}

/**
 * 排程去重：同 (journey, kind, goalKey) 只排一次。
 * reconcile 崩溃恢复补任务时用它，避免重复排程把故事推进两次。
 */
function claimTaskDedup(journeyId, kind, goalKey, now) {
  const info = getDb().prepare(`
    INSERT OR IGNORE INTO task_dedup (journey_id, kind, goal_key, created_at) VALUES (?, ?, ?, ?)
  `).run(journeyId, kind, goalKey, now);
  return info.changes > 0;
}

function hasTaskDedup(journeyId, kind, goalKey) {
  return !!getDb().prepare(
    `SELECT 1 FROM task_dedup WHERE journey_id = ? AND kind = ? AND goal_key = ?`
  ).get(journeyId, kind, goalKey);
}

/** 不去重的直排（首次正常排程路径） */
function scheduleTaskOnce({ id, journeyId, kind, dueAt, payload, goalKey, now }) {
  const d = getDb();
  const tx = d.transaction(() => {
    if (goalKey && !claimTaskDedup(journeyId, kind, goalKey, now)) return false;
    d.prepare(`
      INSERT INTO tasks (id, journey_id, kind, due_at, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, journeyId, kind, dueAt, payload ? JSON.stringify(payload) : null, now, now);
    return true;
  });
  return tx();
}

/** 取得到期任务：先到先租；同一旅程每 tick 限额（公平） */
function claimDueTasks(now, { limit = 3, leaseMs = 5 * 60e3, maxPerJourney = 1 } = {}) {
  const rows = getDb().prepare(`
    SELECT * FROM tasks WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC, created_at ASC LIMIT 50
  `).all(now);
  const claimed = [];
  const perJourney = new Map();
  const leaseKey = crypto.randomBytes(8).toString('base64url');
  for (const t of rows) {
    if (claimed.length >= limit) break;
    const c = perJourney.get(t.journey_id) || 0;
    if (c >= maxPerJourney) continue;
    const info = getDb().prepare(`
      UPDATE tasks SET status = 'leased', lease_until = ?, lease_key = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now + leaseMs, leaseKey, now, t.id);
    if (info.changes > 0) {
      claimed.push(getTask(t.id));
      perJourney.set(t.journey_id, c + 1);
    }
  }
  return claimed;
}

function recoverExpiredLeases(now) {
  const info = getDb().prepare(`
    UPDATE tasks SET status = 'pending', lease_until = NULL, lease_key = NULL, updated_at = ?
    WHERE status = 'leased' AND lease_until < ?
  `).run(now, now);
  return info.changes;
}

// —— 租约持有者条件更新（阶段 D）——
//
// 旧 worker 的迟到结果不得覆盖新持有者。三个收尾动作都必须核对 lease_key：
// 如果租约已过期并被回收给别人，本 worker 的写入影响行数为 0，直接丢弃。

function completeTask(id, now, leaseKey) {
  const conds = [`id = @id`];
  const params = { id, updated_at: now };
  if (leaseKey != null) { conds.push(`lease_key = @lease_key`); params.lease_key = leaseKey; }
  const info = getDb().prepare(`
    UPDATE tasks SET status = 'done', lease_until = NULL, lease_key = NULL, updated_at = @updated_at
    WHERE ${conds.join(' AND ')}
  `).run(params);
  return info.changes > 0;
}

/**
 * 重新排程（正常等待 / 错误重试共用）。
 * 不动 attempts —— 正常等待不消耗错误重试次数。
 */
function rescheduleTask(id, dueAt, now, leaseKey) {
  const conds = [`id = @id`, `status = 'leased'`];
  const params = { id, due_at: dueAt, updated_at: now };
  if (leaseKey != null) { conds.push(`lease_key = @lease_key`); params.lease_key = leaseKey; }
  const info = getDb().prepare(`
    UPDATE tasks SET status = 'pending', due_at = @due_at, lease_until = NULL, lease_key = NULL, updated_at = @updated_at
    WHERE ${conds.join(' AND ')}
  `).run(params);
  return info.changes > 0;
}

function failTask(id, error, now, leaseKey) {
  const conds = [`id = @id`];
  const params = { id, last_error: String(error || '').slice(0, 500), updated_at: now };
  if (leaseKey != null) { conds.push(`lease_key = @lease_key`); params.lease_key = leaseKey; }
  const info = getDb().prepare(`
    UPDATE tasks SET status = 'failed', last_error = @last_error, lease_until = NULL, lease_key = NULL, updated_at = @updated_at
    WHERE ${conds.join(' AND ')}
  `).run(params);
  return info.changes > 0;
}

function cancelTasksForJourney(journeyId, now) {
  const info = getDb().prepare(`
    UPDATE tasks SET status = 'cancelled', lease_until = NULL, lease_key = NULL, updated_at = ?
    WHERE journey_id = ? AND status IN ('pending', 'leased') AND kind != 'image'
  `).run(now, journeyId);
  return info.changes;
}

function countOpenTasks(journeyId) {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM tasks WHERE journey_id = ? AND status IN ('pending','leased')`).get(journeyId).c;
}

function accelerateTask(journeyId, kind, dueAt, now) {
  const info = getDb().prepare(`
    UPDATE tasks SET due_at = ?, updated_at = ?
    WHERE journey_id = ? AND kind = ? AND status = 'pending' AND due_at > ?
  `).run(dueAt, now, journeyId, kind, dueAt);
  return info.changes > 0;
}

function minPendingDueAt() {
  return getDb().prepare(`SELECT MIN(due_at) AS t FROM tasks WHERE status = 'pending'`).get().t;
}

// ==================== 命令幂等（阶段 C.4） ====================

/**
 * 读取既有幂等结果。
 * @returns 同键同载荷 → {hit:true, result}；同键异载荷 → {hit:true, conflict:true}
 */
function readCommandResult({ ownerKey, operation, requestId, fingerprint }) {
  if (!requestId) return { hit: false };
  const row = getDb().prepare(
    `SELECT fingerprint, result_json FROM command_requests WHERE owner_key = ? AND operation = ? AND request_id = ?`
  ).get(ownerKey, operation, requestId);
  if (!row) return { hit: false };
  if (row.fingerprint !== fingerprint) return { hit: true, conflict: true };
  try { return { hit: true, result: JSON.parse(row.result_json) }; } catch (e) { return { hit: true, result: null }; }
}

/**
 * 在事务内二次核对幂等键。
 * 命令层在事务开始前先查一次只是为了快速返回；这里保证并发下同键只落一次。
 *
 * @param tx 事务句柄（本文件的 raw handle，命令层不得直接 prepare）
 * @returns {{replay:boolean, result?:object, conflict?:boolean}}
 */
function readCommandResultIn(tx, { ownerKey, operation, requestId, fingerprint }) {
  if (!requestId) return { replay: false };
  const row = tx.prepare(
    `SELECT fingerprint, result_json FROM command_requests WHERE owner_key = ? AND operation = ? AND request_id = ?`
  ).get(ownerKey, operation, requestId);
  if (!row) return { replay: false };
  if (row.fingerprint !== fingerprint) return { replay: false, conflict: true };
  try { return { replay: true, result: JSON.parse(row.result_json) }; } catch (e) { return { replay: true, result: null }; }
}

/**
 * 持久化幂等结果。调用方必须在**与业务变化同一个事务**里调用它，
 * 保证"结果与业务变化同生共死"，重启后仍然有效。
 *
 * @param tx 事务句柄（本文件的 raw handle，命令层不得直接 prepare）
 */
function recordCommandResult(tx, { ownerKey, operation, requestId, fingerprint, result, now }) {
  if (!requestId) return;
  tx.prepare(
    `INSERT INTO command_requests (owner_key, operation, request_id, fingerprint, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_key, operation, request_id) DO NOTHING`
  ).run(ownerKey, operation, requestId, fingerprint, JSON.stringify(result), now);
}

/** 供 commit 层在事务内读取旅程状态（commit 不得自己写 SQL） */
function readJourneyIn(tx, journeyId) {
  return tx.prepare(`SELECT * FROM journeys WHERE id = ?`).get(journeyId) || null;
}

/**
 * commit 层的前置复核读取（事务外）。
 * commit 需要"提交前重新核对当前状态"，但不允许自己写 SQL，
 * 因此由存储层提供这个专用读取。
 */
function readJourneyForCommit(journeyId) {
  return getDb().prepare(`SELECT * FROM journeys WHERE id = ?`).get(journeyId) || null;
}

/** 供 commit 层统计某旅程的某类任务 */
function readJourneyTaskIn(tx, journeyId) {
  return tx.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE journey_id = ? AND kind = 'image'`).get(journeyId).c;
}

/** workflow 的只读统计：某旅程已有多少封该类型来信（用于配图预算判定） */
function countMessagesOfKind(journeyId, kind) {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM messages WHERE journey_id = ? AND kind = ?`)
    .get(journeyId, kind).c;
}

// ==================== 业务 operation 台账（阶段 D） ====================

/**
 * 用唯一约束做原子去重。
 * @returns 'applied' 首次落账 | 'already_applied' 幂等命中
 * 不用"检查后再插入"的非原子方式。
 */
function claimOperation({ operationId, journeyId, kind, detail, now }) {
  const info = getDb().prepare(`
    INSERT OR IGNORE INTO operations (operation_id, journey_id, kind, status, detail_json, created_at)
    VALUES (?, ?, ?, 'claimed', ?, ?)
  `).run(operationId, journeyId, kind, detail ? JSON.stringify(detail) : null, now);
  return info.changes > 0 ? 'applied' : 'already_applied';
}

function hasOperation(operationId) {
  return !!getDb().prepare(`SELECT 1 FROM operations WHERE operation_id = ?`).get(operationId);
}

function getOperations(journeyId) {
  return getDb().prepare(`SELECT * FROM operations WHERE journey_id = ? ORDER BY created_at ASC`).all(journeyId);
}

function markOperation(operationId, status, detail) {
  getDb().prepare(`UPDATE operations SET status = ?, detail_json = COALESCE(?, detail_json) WHERE operation_id = ?`)
    .run(status, detail ? JSON.stringify(detail) : null, operationId);
}

// ==================== 模型调用台账 ====================

/**
 * 记录一次真实网络尝试。
 * 区分逻辑 operation 与 transport attempt：适配器内部重试会多次记账。
 * 无网络调用的预算拒绝用 status='budget_denied' 单独记录，不混入真实尝试。
 */
function recordModelCall({
  journeyId, taskId, encounterId, operationId, operationKind, attempt,
  kind, provider, model, usage, latencyMs, status, error, now
}) {
  getDb().prepare(`
    INSERT INTO model_calls
      (journey_id, task_id, encounter_id, operation_id, operation_kind, attempt,
       kind, provider, model, usage_json, latency_ms, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    journeyId || null, taskId || null, encounterId || null, operationId || null,
    operationKind || null, attempt == null ? null : attempt,
    kind, provider || null, model || null,
    usage ? JSON.stringify(usage) : null, latencyMs || null, status, error || null, now
  );
}

function countModelCalls(journeyId) {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM model_calls WHERE journey_id = ?`).get(journeyId).c;
}

function getModelCalls(journeyId) {
  return getDb().prepare(`SELECT * FROM model_calls WHERE journey_id = ? ORDER BY id ASC`).all(journeyId)
    .map(r => ({ ...r, usage: (() => { try { return r.usage_json ? JSON.parse(r.usage_json) : null; } catch (e) { return null; } })() }));
}

  return {
    initDb, getDb, getDbPath, closeDb, rid,
    runMigrations, currentVersion,

    upsertSession, getSessionByTokenHash,
    createCreature, getCreature, getCreaturesByOwner, getOwnedCreature,
    createJourney, getJourney, getOwnedJourney, getJourneysByOwner, getActiveJourneys,
    countJourneysByCreature, updateJourney, endJourneyByUser, updateTone,
    saveMotivation, getMotivation,
    insertEncounter, getEncounter, getEncounters, getEncounterBySeq, getLatestEncounter,
    getEncounterBySignalMessageId,
    freezeEncounterSignal, attachSupply, decideEncounter, resolveEncounter,
    markEncounterStatus, reproposalEncounter,
    readResolvedProposals, readLastResolved, readJourneysByCreature, readPublicPulse,
    insertFacts, getFacts,
    insertMechanismCard, getRecentCards,
    insertMessage, getMessage, getMessages, lastUserFacingAt,
    setMessagesStatusByEncounter, attachMessageImage,
    insertTask, getTask, hasOpenTask, scheduleTaskOnce, claimTaskDedup, hasTaskDedup,
    claimDueTasks, recoverExpiredLeases,
    completeTask, rescheduleTask, failTask, cancelTasksForJourney,
    countOpenTasks, accelerateTask, minPendingDueAt,
    readCommandResult, readCommandResultIn, recordCommandResult,
    readJourneyIn, readJourneyForCommit, readJourneyTaskIn, countMessagesOfKind,
    claimOperation, hasOperation, getOperations, markOperation,
    recordModelCall, countModelCalls, getModelCalls
  };
}

module.exports = {
  SCHEMA_VERSION, REPO_ROOT, LEGACY_DB_PATH, resolveDbPath,
  createStore,
  runMigrations, currentVersion, hasColumn, preflightUniqueIndex, MIGRATIONS
};
