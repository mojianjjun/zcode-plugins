"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sqlQuery = sqlQuery;
exports.testConnection = testConnection;
exports.listTables = listTables;
exports.describeTable = describeTable;
exports.mongoFind = mongoFind;
exports.mongoAggregate = mongoAggregate;
exports.jsonSafe = jsonSafe;
/**
 * drivers：MySQL / PostgreSQL / MongoDB 执行层。
 * 约定（REQUIREMENTS §5/§6）：
 *  - 每次调用建立连接、用完即关，不做常驻连接池；
 *  - 值只经驱动参数绑定传入（MySQL 用 ?，PostgreSQL 用 $n；Mongo 传文档对象）；
 *  - 查询超时（timeoutMs）与行数上限（limit+1 探测截断）在驱动层强制；
 *  - 表结构浏览走 information_schema，表名作为"值"参数绑定，不做标识符拼接。
 */
const mysql = __importStar(require("mysql2/promise"));
const pg_1 = require("pg");
const mongodb_1 = require("mongodb");
function withTimeout(p, ms, onTimeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            onTimeout();
            reject(new Error(`查询超过 ${ms}ms 超时，已中止`));
        }, ms);
        p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}
/** 行数据 JSON 安全化：Date→ISO、BigInt→字符串、Buffer→hex 摘要 */
function jsonSafe(value, depth = 0) {
    if (depth > 20)
        return '[深度超限]';
    if (typeof value === 'bigint')
        return value.toString();
    if (value instanceof Date)
        return value.toISOString();
    if (Buffer.isBuffer(value)) {
        const hex = value.toString('hex');
        return `0x${hex.length > 64 ? hex.slice(0, 64) + `…(${value.length} bytes)` : hex}`;
    }
    if (value instanceof Uint8Array)
        return `(binary ${value.length} bytes)`;
    if (value === null || value === undefined)
        return value;
    if (Array.isArray(value))
        return value.map((v) => jsonSafe(v, depth + 1));
    if (typeof value === 'object') {
        const ctor = value.constructor?.name;
        if (ctor && ctor !== 'Object' && ctor !== 'Array')
            return String(value);
        const out = {};
        for (const k of Object.keys(value)) {
            out[k] = jsonSafe(value[k], depth + 1);
        }
        return out;
    }
    return value;
}
function truncate(rows, limit) {
    if (rows.length > limit)
        return { rows: rows.slice(0, limit), truncated: true };
    return { rows, truncated: false };
}
function friendlyConnError(e, cfg) {
    const msg = e?.message ?? String(e);
    const code = e?.code;
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
        return new Error(`无法连接 ${cfg.host ?? cfg.url ?? ''}:${cfg.port ?? ''}（${code}）：请确认地址/端口与数据库是否运行`);
    }
    if (/access denied|password authentication|authentication failed/i.test(msg)) {
        return new Error(`认证失败：请检查用户名/密码（密码来自环境变量，确认变量值正确）：${msg}`);
    }
    return new Error(msg);
}
/* ------------------------- MySQL ------------------------- */
async function mysqlConnect(cfg, timeoutMs) {
    const options = {
        connectTimeout: Math.min(timeoutMs, 20000),
        dateStrings: true,
        multipleStatements: false,
        supportBigNumbers: true,
    };
    if (cfg.url)
        options.uri = cfg.url;
    else {
        options.host = cfg.host;
        options.port = cfg.port;
        options.user = cfg.user;
        options.password = cfg.password;
        options.database = cfg.database;
    }
    try {
        return await withTimeout(mysql.createConnection(options), timeoutMs, () => undefined);
    }
    catch (e) {
        throw friendlyConnError(e, cfg);
    }
}
async function mysqlRun(cfg, opts, fn) {
    const conn = await mysqlConnect(cfg, opts.timeoutMs);
    let out;
    try {
        out = await withTimeout(fn(conn), opts.timeoutMs, () => { conn.destroy(); });
    }
    finally {
        try {
            await conn.end();
        }
        catch { /* 连接可能已被 destroy */ }
    }
    return out;
}
async function mysqlQuery(cfg, sql, params, opts) {
    const started = Date.now();
    const rows = (await mysqlRun(cfg, opts, (conn) => conn.query(sql, params)))[0];
    const t = truncate(Array.isArray(rows) ? rows : [rows], opts.limit);
    return { ...t, elapsedMs: Date.now() - started };
}
/* ------------------------- PostgreSQL ------------------------- */
async function pgConnect(cfg, timeoutMs) {
    const config = {
        connectionTimeoutMillis: timeoutMs,
        statement_timeout: timeoutMs,
        query_timeout: timeoutMs,
    };
    if (cfg.url)
        config.connectionString = cfg.url;
    else {
        config.host = cfg.host;
        config.port = cfg.port;
        config.user = cfg.user;
        config.password = cfg.password;
        config.database = cfg.database;
    }
    const client = new pg_1.Client(config);
    try {
        await withTimeout(client.connect(), timeoutMs, () => { client.end().catch(() => undefined); });
    }
    catch (e) {
        throw friendlyConnError(e, cfg);
    }
    return client;
}
async function pgRun(cfg, opts, fn) {
    const client = await pgConnect(cfg, opts.timeoutMs);
    try {
        return await fn(client);
    }
    finally {
        await client.end().catch(() => undefined);
    }
}
async function pgQuery(cfg, sql, params, opts) {
    const started = Date.now();
    const res = await pgRun(cfg, opts, (client) => client.query({ text: sql, values: params }));
    const t = truncate(res.rows ?? [], opts.limit);
    return { ...t, elapsedMs: Date.now() - started };
}
/* ------------------------- MongoDB ------------------------- */
async function mongoConnect(cfg, timeoutMs) {
    if (!cfg.url)
        throw new Error('MongoDB 连接需要 url 字段');
    const client = new mongodb_1.MongoClient(cfg.url, {
        serverSelectionTimeoutMS: timeoutMs,
        connectTimeoutMS: timeoutMs,
    });
    try {
        await withTimeout(client.connect(), timeoutMs, () => { client.close().catch(() => undefined); });
    }
    catch (e) {
        throw friendlyConnError(e, cfg);
    }
    const db = cfg.database ? client.db(cfg.database) : client.db();
    return { client, db };
}
async function mongoRun(cfg, opts, fn) {
    const { client, db } = await mongoConnect(cfg, opts.timeoutMs);
    try {
        return await withTimeout(fn(db), opts.timeoutMs, () => { client.close().catch(() => undefined); });
    }
    finally {
        await client.close().catch(() => undefined);
    }
}
/* ------------------------- 统一入口 ------------------------- */
function sqlQuery(type, cfg, sql, params, opts) {
    return type === 'mysql' ? mysqlQuery(cfg, sql, params, opts) : pgQuery(cfg, sql, params, opts);
}
async function testConnection(cfg, timeoutMs) {
    const started = Date.now();
    if (cfg.type === 'mysql') {
        const rows = await mysqlRun(cfg, { timeoutMs, limit: 1 }, (conn) => conn.query('SELECT VERSION() AS version'));
        const r = rows[0][0];
        return { serverInfo: `MySQL ${r?.version ?? '未知版本'}`, elapsedMs: Date.now() - started };
    }
    if (cfg.type === 'postgres') {
        const res = await pgRun(cfg, { timeoutMs, limit: 1 }, (c) => c.query('SELECT version() AS version'));
        return { serverInfo: String(res.rows[0]?.version ?? '未知版本').split(' (')[0], elapsedMs: Date.now() - started };
    }
    // mongodb
    const info = await mongoRun(cfg, { timeoutMs, limit: 1 }, async (db) => {
        const ping = await db.command({ ping: 1 });
        let version = '未知版本';
        try {
            const build = await db.command({ buildInfo: 1 });
            version = String(build.version ?? version);
        }
        catch { /* 部分权限下 buildInfo 不可用 */ }
        return { ping, version };
    });
    return { serverInfo: `MongoDB ${info.version}（ping ${info.ping?.ok === 1 ? '通过' : '失败'}）`, elapsedMs: Date.now() - started };
}
async function listTables(cfg, opts) {
    const started = Date.now();
    if (cfg.type === 'mysql') {
        const rows = await mysqlRun(cfg, opts, (conn) => conn.query('SELECT TABLE_NAME AS name, TABLE_ROWS AS rowEstimate, TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME'));
        const list = rows[0];
        return { rows: list, truncated: false, elapsedMs: Date.now() - started };
    }
    if (cfg.type === 'postgres') {
        const res = await pgRun(cfg, opts, (c) => c.query(`SELECT c.relname AS name, c.reltuples::bigint AS "rowEstimate",
                CASE c.relkind WHEN 'r' THEN 'BASE TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'p' THEN 'PARTITIONED TABLE' ELSE c.relkind::text END AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relkind IN ('r','v','m','p')
         ORDER BY c.relname`));
        return { rows: res.rows, truncated: false, elapsedMs: Date.now() - started };
    }
    // mongodb：列出集合与文档数估计
    const list = await mongoRun(cfg, opts, async (db) => {
        const cols = await db.listCollections().toArray();
        const out = [];
        for (const col of cols.slice(0, opts.limit)) {
            let est = -1;
            try {
                est = await db.collection(col.name).estimatedDocumentCount();
            }
            catch { /* 忽略单个集合计数失败 */ }
            out.push({ name: col.name, kind: String(col.type ?? 'collection'), rowEstimate: est });
        }
        return out;
    });
    return { rows: list, truncated: false, elapsedMs: Date.now() - started };
}
async function describeTable(cfg, table, opts) {
    if (cfg.type === 'mysql') {
        const res = await mysqlRun(cfg, opts, async (conn) => {
            const columns = (await conn.query('SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS keyInfo, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [table]))[0];
            const idxRows = (await conn.query('SELECT INDEX_NAME AS name, COLUMN_NAME AS column_name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX', [table]))[0];
            const indexMap = new Map();
            for (const r of idxRows) {
                const entry = indexMap.get(r.name) ?? { name: r.name, unique: r.nonUnique === 0, columns: [] };
                entry.columns.push(r.column_name);
                indexMap.set(r.name, entry);
            }
            return { columns, indexes: [...indexMap.values()] };
        });
        return res;
    }
    if (cfg.type === 'postgres') {
        return pgRun(cfg, opts, async (c) => {
            const columns = (await c.query('SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS "default" FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position', [table])).rows;
            const indexes = (await c.query('SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY indexname', [table])).rows;
            return { columns, indexes };
        });
    }
    // mongodb：采样文档推断字段 + 索引列表
    return mongoRun(cfg, opts, async (db) => {
        const coll = db.collection(table);
        const sampleDoc = await coll.findOne({}, { timeoutMs: opts.timeoutMs });
        const fields = [];
        const infer = (obj, prefix = '') => {
            for (const [k, v] of Object.entries(obj)) {
                const label = prefix ? `${prefix}.${k}` : k;
                const t = v === null ? 'null' : Array.isArray(v) ? `array<${typeof v[0]}>` : v instanceof Date ? 'date' : typeof v;
                fields.push({ field: label, type: t });
                if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && prefix.split('.').length < 2) {
                    infer(v, label);
                }
            }
        };
        if (sampleDoc)
            infer(sampleDoc);
        let indexes = [];
        try {
            indexes = await coll.indexes();
        }
        catch { /* 权限不足时忽略 */ }
        return { fields, indexes, sample: sampleDoc };
    });
}
async function mongoFind(cfg, collection, filter, projection, sort, opts) {
    const started = Date.now();
    const rows = await mongoRun(cfg, opts, async (db) => {
        let cursor = db.collection(collection).find(filter).limit(opts.limit + 1);
        if (projection)
            cursor = cursor.project(projection);
        if (sort)
            cursor = cursor.sort(sort);
        cursor = cursor.maxTimeMS(opts.timeoutMs);
        return cursor.toArray();
    });
    const t = truncate(rows, opts.limit);
    return { ...t, elapsedMs: Date.now() - started };
}
async function mongoAggregate(cfg, collection, pipeline, opts) {
    const started = Date.now();
    const rows = await mongoRun(cfg, opts, async (db) => {
        const stages = [...pipeline, { $limit: opts.limit + 1 }];
        return db.collection(collection).aggregate(stages, { maxTimeMS: opts.timeoutMs }).toArray();
    });
    const t = truncate(rows, opts.limit);
    return { ...t, elapsedMs: Date.now() - started };
}
