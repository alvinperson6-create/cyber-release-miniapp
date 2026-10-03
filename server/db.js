// 赛博放生 · 权威旅程内核（v2）
//
// schema 原则（handoff §4.2）：
// - 程序掌握权威事实：encounters/facts/messages 均为追加式持久账本，
//   每条已提交记录有稳定 ID；模型文字必须经程序校验后由程序落账
// - 状态版本（state_version）做乐观锁：提案冻结时的版本、决策/结算的
//   条件更新，重复调度/并发留言/进程重启都不会双写或覆盖
// - 模型调用在事务外；这里的所有写操作都是短事务
// - 任务表带租约（lease）：崩溃/重启后到期回收，按 due_at 公平取用
// - 旧四集 schema 不再创建、不再迁移（旧数据无需兼容，handoff §4.1）

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('node:crypto');

// DB 路径每次 initDb 时解析（测试在同进程内切换隔离库）
function resolveDbPath() {
  return process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'data.db');
}

let db = null;

function initDb() {
  closeDb();
  db = new Database(resolveDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.prepare(`
    CREATE TABLE IF NOT EXISTS creatures (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      species TEXT NOT NULL,
      origin_journey_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();

  db.prepare(`
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
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_journeys_owner ON journeys(owner_key, created_at)`).run();

  // 本程动机档案（版本化）：原文 + 识别结果；识别不可用时 status=pending 等待重试
  db.prepare(`
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
    )
  `).run();

  // 遭遇：提案由程序冻结；决策与结算按条件更新推进
  db.prepare(`
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
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_encounters_journey ON encounters(journey_id, seq)`).run();

  // 事实账本（追加式）
  db.prepare(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journey_id TEXT NOT NULL,
      encounter_id TEXT,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      detail_json TEXT,
      created_at INTEGER NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_facts_journey ON facts(journey_id, id)`).run();

  // 机制卡：压力来源—两难—选择代价—持久后果（去重对象）
  db.prepare(`
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
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_cards_creature ON mechanism_cards(creature_id, id)`).run();

  // 消息：signal / letter / final_letter / user_reply / system
  db.prepare(`
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
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_journey ON messages(journey_id, sent_at)`).run();

  // 任务队列：lease + 重试 + 幂等
  db.prepare(`
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
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, due_at)`).run();

  // 模型调用台账（含 JEV），预算与成本追踪
  db.prepare(`
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
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_calls_journey ON model_calls(journey_id)`).run();

  // 匿名会话：cookie token 的 sha256 → owner_key（凭据本身不落库、不进日志）
  db.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )
  `).run();

  return db;
}

function getDb() {
  if (!db) initDb();
  return db;
}

// 测试专用：关闭当前连接并清空模块级实例，让下一次 initDb 指向新的 DB_PATH
function closeDb() {
  if (db) {
    try { db.close(); } catch (e) { /* already closed */ }
    db = null;
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

// 同一所有者名下的生物（“让这只生物再次出发”的来源）
function getCreaturesByOwner(ownerKey) {
  return getDb().prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM journeys j WHERE j.creature_id = c.id) AS journey_count
    FROM creatures c WHERE c.owner_key = ? ORDER BY c.created_at ASC
  `).all(ownerKey);
}

// 归属校验：creature 必须属于 owner
function getOwnedCreature(id, ownerKey) {
  return getDb().prepare(`SELECT * FROM creatures WHERE id = ? AND owner_key = ?`).get(id, ownerKey) || null;
}

function createJourney({ id, creatureId, ownerKey, species, water, feeling, tone, now }) {
  getDb().prepare(`
    INSERT INTO journeys (id, creature_id, owner_key, species, water, feeling, tone, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
  `).run(id, creatureId, ownerKey, species, water, feeling, tone || 'balanced', now, now);
  // 本程动机档案 v1：先持久化原文，识别状态 pending（后台补齐）
  getDb().prepare(`
    INSERT INTO motivations (journey_id, version, raw_text, status, created_at)
    VALUES (?, 1, ?, 'pending', ?)
  `).run(id, feeling, now);
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

// 进行中旅程（调度/恢复对象；paused 已被护栏暂停，不参与自动推进）
function getActiveJourneys(limit = 50) {
  return getDb().prepare(`
    SELECT * FROM journeys
    WHERE status IN ('preparing', 'active')
    ORDER BY created_at ASC LIMIT ?
  `).all(limit);
}

function countJourneysByCreature(creatureId) {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM journeys WHERE creature_id = ?`).get(creatureId).c;
}

// 条件更新：乐观锁。expected 里的字段必须与库内一致才生效
function updateJourney(id, fields, expected = {}) {
  const all = { ...fields, updated_at: Date.now() };
  const keys = Object.keys(all);
  if (!keys.length) return false;
  const conds = [`id = @id`];
  const params = { id };
  for (const k of keys) params[`f_${k}`] = all[k];
  for (const [k, v] of Object.entries(expected)) {
    conds.push(v === null ? `${k} IS NULL` : `${k} = @e_${k}`);
    if (v !== null) params[`e_${k}`] = v;
  }
  const sets = keys.map(k => `${k} = @f_${k}`).join(', ');
  const info = getDb().prepare(`UPDATE journeys SET ${sets} WHERE ${conds.join(' AND ')}`).run(params);
  return info.changes > 0;
}

// 用户主动结束：立即生效，不等任何模型调用；非进行中旅程不可结束
function endJourneyByUser(id, now) {
  const info = getDb().prepare(`
    UPDATE journeys SET status = 'ended_user', ending_reason = 'user', updated_at = ?
    WHERE id = ? AND status IN ('preparing', 'active', 'paused')
  `).run(now, id);
  return info.changes > 0;
}

function updateTone(id, tone) {
  return updateJourney(id, { tone }, { });
}

// ==================== 动机档案 ====================
function saveMotivation(journeyId, version, { status, items, note, now }) {
  getDb().prepare(`
    UPDATE motivations SET status = ?, items_json = ?, note = ?
    WHERE journey_id = ? AND version = ?
  `).run(status, items ? JSON.stringify(items) : null, note || null, journeyId, version);
  getDb().prepare(`UPDATE journeys SET motivation_version = ?, updated_at = ? WHERE id = ?`)
    .run(version, now, journeyId);
  return getMotivation(journeyId, version);
}

function getMotivation(journeyId, version) {
  const row = version
    ? getDb().prepare(`SELECT * FROM motivations WHERE journey_id = ? AND version = ?`).get(journeyId, version)
    : getDb().prepare(`SELECT * FROM motivations WHERE journey_id = ? ORDER BY version DESC LIMIT 1`).get(journeyId);
  if (!row) return null;
  let items = null;
  try { items = row.items_json ? JSON.parse(row.items_json) : null; } catch (e) { items = null; }
  return { id: row.id, journeyId: row.journey_id, version: row.version, rawText: row.raw_text, status: row.status, items, note: row.note, createdAt: row.created_at };
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

// 冻结信号：proposed → signal_sent（同一遭遇只可能寄一次信号，条件更新保证）
function freezeEncounterSignal(id, { messageId, dueAt, now }) {
  const info = getDb().prepare(`
    UPDATE encounters SET status = 'signal_sent', signal_message_id = ?, signal_due_at = ?, updated_at = ?
    WHERE id = ? AND status = 'proposed'
  `).run(messageId, dueAt, now, id);
  return info.changes > 0;
}

// 记录按时补给（signal_sent 仍成立时才可能成功；返回是否抢到）
function attachSupply(id, messageId, now) {
  const info = getDb().prepare(`
    UPDATE encounters SET supply_message_id = ?, updated_at = ?
    WHERE id = ? AND status = 'signal_sent' AND supply_message_id IS NULL
  `).run(messageId, now, id);
  return info.changes > 0;
}

// JEV 决策落账：proposed/signal_sent → decided（一次性提交；迟到回复不得改写）
function decideEncounter(id, { action, source, meta, now }) {
  const info = getDb().prepare(`
    UPDATE encounters SET status = 'decided', chosen_action = ?, decision_source = ?, decision_meta_json = ?, updated_at = ?
    WHERE id = ? AND status IN ('proposed', 'signal_sent')
  `).run(action, source, meta ? JSON.stringify(meta) : null, now, id);
  return info.changes > 0;
}

// 结算落账：decided → resolved（outcome + 状态版本推进）
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

// 定向重提案：保留同一 seq，覆盖提案内容（reproposals+1，状态回到 proposed）
function reproposalEncounter(id, { proposal, stateVersion, now }) {
  const info = getDb().prepare(`
    UPDATE encounters SET proposal_json = ?, state_version = ?, reproposals = reproposals + 1,
      status = 'proposed', updated_at = ?
    WHERE id = ? AND status = 'proposed'
  `).run(JSON.stringify(proposal), stateVersion, now, id);
  return info.changes > 0;
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
  return getDb().prepare(`
    SELECT * FROM mechanism_cards WHERE creature_id = ? ORDER BY id DESC LIMIT ?
  `).all(creatureId, limit);
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

// 用户面向消息的最新发送时间（最小间隔/最大静默护栏用）
function lastUserFacingAt(journeyId) {
  const row = getDb().prepare(`
    SELECT MAX(sent_at) AS t FROM messages
    WHERE journey_id = ? AND kind IN ('signal', 'letter', 'final_letter')
  `).get(journeyId);
  return row?.t || null;
}

// 服务性状态提示与生物来信分开计数
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

// 幂等去重：同一旅程同一 kind 的 pending/leased 任务是否已存在
function hasOpenTask(journeyId, kind) {
  return !!getDb().prepare(`
    SELECT 1 FROM tasks WHERE journey_id = ? AND kind = ? AND status IN ('pending', 'leased') LIMIT 1
  `).get(journeyId, kind);
}

// 取得到期任务：先到先租（条件更新保证只有一个 worker 抢到），同一旅程每次 tick 最多 1 条（公平）
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

// 崩溃恢复：租约过期的任务回到 pending（attempts 已在租用时 +1，重试上限由调用方判）
function recoverExpiredLeases(now) {
  const info = getDb().prepare(`
    UPDATE tasks SET status = 'pending', lease_until = NULL, lease_key = NULL, updated_at = ?
    WHERE status = 'leased' AND lease_until < ?
  `).run(now, now);
  return info.changes;
}

function completeTask(id, now) {
  getDb().prepare(`UPDATE tasks SET status = 'done', lease_until = NULL, lease_key = NULL, updated_at = ? WHERE id = ?`).run(now, id);
}

// 重试：回到 pending 并退避；attempts 超限时标 failed（由调用方决定旅程暂停）
function retryTask(id, dueAt, now) {
  getDb().prepare(`
    UPDATE tasks SET status = 'pending', due_at = ?, lease_until = NULL, lease_key = NULL, updated_at = ? WHERE id = ?
  `).run(dueAt, now, id);
}

function failTask(id, error, now) {
  getDb().prepare(`UPDATE tasks SET status = 'failed', last_error = ?, lease_until = NULL, lease_key = NULL, updated_at = ? WHERE id = ?`)
    .run(String(error || '').slice(0, 500), now, id);
}

function cancelTasksForJourney(journeyId, now) {
  // image 任务豁免：它只给已投递的信追加配图（非阻塞），旅程收束后仍应完成
  const info = getDb().prepare(`
    UPDATE tasks SET status = 'cancelled', updated_at = ?
    WHERE journey_id = ? AND status IN ('pending', 'leased') AND kind != 'image'
  `).run(now, journeyId);
  return info.changes;
}

function countOpenTasks(journeyId) {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM tasks WHERE journey_id = ? AND status IN ('pending','leased')`).get(journeyId).c;
}

// 把某旅程某类 pending 任务提前到 dueAt（用户按时补给后立即唤醒决策用）
function accelerateTask(journeyId, kind, dueAt, now) {
  const info = getDb().prepare(`
    UPDATE tasks SET due_at = ?, updated_at = ?
    WHERE journey_id = ? AND kind = ? AND status = 'pending' AND due_at > ?
  `).run(dueAt, now, journeyId, kind, dueAt);
  return info.changes > 0;
}

// ==================== 模型调用台账 ====================
function recordModelCall({ journeyId, taskId, kind, provider, model, usage, latencyMs, status, error, now }) {
  getDb().prepare(`
    INSERT INTO model_calls (journey_id, task_id, kind, provider, model, usage_json, latency_ms, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(journeyId || null, taskId || null, kind, provider || null, model || null,
    usage ? JSON.stringify(usage) : null, latencyMs || null, status, error || null, now);
}

function countModelCalls(journeyId) {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM model_calls WHERE journey_id = ?`).get(journeyId).c;
}

function getModelCalls(journeyId) {
  return getDb().prepare(`SELECT * FROM model_calls WHERE journey_id = ? ORDER BY id ASC`).all(journeyId)
    .map(r => ({ ...r, usage: (() => { try { return r.usage_json ? JSON.parse(r.usage_json) : null; } catch (e) { return null; } })() }));
}

module.exports = {
  initDb, getDb, closeDb, rid,
  upsertSession, getSessionByTokenHash,
  createCreature, getCreature, getCreaturesByOwner, getOwnedCreature,
  createJourney, getJourney, getOwnedJourney, getJourneysByOwner, getActiveJourneys,
  countJourneysByCreature, updateJourney, endJourneyByUser, updateTone,
  saveMotivation, getMotivation,
  insertEncounter, getEncounter, getEncounters, getEncounterBySeq, getLatestEncounter,
  freezeEncounterSignal, attachSupply, decideEncounter, resolveEncounter,
  markEncounterStatus, reproposalEncounter,
  insertFacts, getFacts,
  insertMechanismCard, getRecentCards,
  insertMessage, getMessage, getMessages, lastUserFacingAt,
  setMessagesStatusByEncounter, attachMessageImage,
  insertTask, getTask, hasOpenTask, claimDueTasks, recoverExpiredLeases,
  completeTask, retryTask, failTask, cancelTasksForJourney, countOpenTasks, accelerateTask,
  recordModelCall, countModelCalls, getModelCalls
};
