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
exports.DEFAULT_TIMEOUT_MS = exports.DEFAULT_MAX_ROW_LIMIT = exports.DEFAULT_ROW_LIMIT = exports.DB_TYPES = void 0;
exports.emptyConfigFile = emptyConfigFile;
exports.findWorkspaceConfigPath = findWorkspaceConfigPath;
exports.userConfigPath = userConfigPath;
exports.parseEnvFile = parseEnvFile;
exports.findWorkspaceEnvPath = findWorkspaceEnvPath;
exports.userEnvPath = userEnvPath;
exports.loadEnvVars = loadEnvVars;
exports.mergeConfigFiles = mergeConfigFiles;
exports.loadMergedConfig = loadMergedConfig;
exports.resolveEnvPlaceholders = resolveEnvPlaceholders;
exports.resolveConnectionRef = resolveConnectionRef;
exports.validateIdentifier = validateIdentifier;
exports.sanitizeConnectionForWrite = sanitizeConnectionForWrite;
exports.persistAddConnection = persistAddConnection;
exports.persistRemoveConnection = persistRemoveConnection;
exports.persistSetActiveEnvironment = persistSetActiveEnvironment;
exports.maskConnection = maskConnection;
/**
 * config：多环境多连接配置的加载、合并、环境变量占位符解析与持久化。
 * 对应 REQUIREMENTS §4：
 *  - 工作区 <workspace>/db-connections.json 与用户级 ~/.zcode/db-connector/connections.json
 *  - 按"环境名+连接名"合并，工作区优先
 *  - 凭证只允许 ${ENV_VAR} 占位符，缺变量时报出变量名
 *  - 持久化仅限白名单路径，原子写入
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
exports.DB_TYPES = ['mysql', 'postgres', 'mongodb'];
exports.DEFAULT_ROW_LIMIT = 200;
exports.DEFAULT_MAX_ROW_LIMIT = 1000;
exports.DEFAULT_TIMEOUT_MS = 10000;
const ENV_REF_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
function emptyConfigFile() {
    return { configVersion: 1, environments: {} };
}
/** 工作区配置路径：从 cwd 向上最多查 4 层，找不到则以 cwd 下文件作为写入目标 */
function findWorkspaceConfigPath(startDir = process.cwd()) {
    let dir = path.resolve(startDir);
    for (let i = 0; i < 4; i++) {
        const candidate = path.join(dir, 'db-connections.json');
        if (fs.existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return path.join(path.resolve(startDir), 'db-connections.json');
}
function userConfigPath() {
    return path.join(os.homedir(), '.zcode', 'db-connector', 'connections.json');
}
/* -------- .env 密码文件支持（v0.1.1）-------- */
/** 解析 dotenv 风格 .env 内容：支持注释、引号值、行内注释、export 前缀 */
function parseEnvFile(content) {
    const out = {};
    for (let line of content.split(/\r?\n/)) {
        line = line.trim();
        if (!line || line.startsWith('#'))
            continue;
        if (line.startsWith('export '))
            line = line.slice(7).trim();
        const eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            continue;
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
            value = value.slice(1, -1);
        }
        else {
            const hash = value.indexOf(' #');
            if (hash >= 0)
                value = value.slice(0, hash).trimEnd();
        }
        out[key] = value;
    }
    return out;
}
/** 从 startDir 向上查找工作区 .env（最多 4 层） */
function findWorkspaceEnvPath(startDir = process.cwd()) {
    let dir = path.resolve(startDir);
    for (let i = 0; i < 4; i++) {
        const candidate = path.join(dir, '.env');
        if (fs.existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
function userEnvPath() {
    return path.join(os.homedir(), '.zcode', 'db-connector', '.env');
}
/**
 * ${VAR} 解析用的变量表，仅来自 .env 文件（v0.1.2 起不读取系统环境变量）。
 * 优先级：工作区 .env > 用户级 .env；保存即生效（每次工具调用重新读取），无需重启。
 */
function loadEnvVars(startDir = process.cwd()) {
    const sources = [];
    const vars = {};
    for (const file of [userEnvPath(), findWorkspaceEnvPath(startDir)]) {
        if (!file || !fs.existsSync(file))
            continue;
        try {
            Object.assign(vars, parseEnvFile(fs.readFileSync(file, 'utf8')));
            sources.push(file);
        }
        catch {
            /* 读取失败的 .env 跳过，不阻断查询 */
        }
    }
    return { vars, sources };
}
function readFileIfExists(file) {
    if (!fs.existsSync(file))
        return null;
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    }
    catch (e) {
        throw new Error(`无法读取配置文件 ${file}：${e.message}`);
    }
    if (!raw.trim())
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.environments !== 'object' || parsed.environments === null) {
            throw new Error('缺少 environments 对象');
        }
        return parsed;
    }
    catch (e) {
        throw new Error(`配置文件 ${file} 不是合法 JSON 或结构不符：${e.message}`);
    }
}
/** 原子写入：先写临时文件再 rename */
function atomicWrite(file, data) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}
function mergeDefaults(ws, us) {
    const d = { ...us, ...ws };
    return {
        rowLimit: d.rowLimit ?? exports.DEFAULT_ROW_LIMIT,
        maxRowLimit: d.maxRowLimit ?? exports.DEFAULT_MAX_ROW_LIMIT,
        timeoutMs: d.timeoutMs ?? exports.DEFAULT_TIMEOUT_MS,
    };
}
/** 合并工作区与用户级配置：环境按名合并，连接按名合并，工作区优先 */
function mergeConfigFiles(ws, us) {
    const environments = {};
    for (const [name, env] of Object.entries(us?.environments ?? {})) {
        environments[name] = { ...env, connections: { ...env.connections } };
    }
    for (const [name, env] of Object.entries(ws?.environments ?? {})) {
        const base = environments[name] ?? { connections: {} };
        environments[name] = {
            ...base,
            ...env,
            connections: { ...base.connections, ...env.connections },
        };
    }
    const activeEnvironment = ws?.activeEnvironment ?? us?.activeEnvironment;
    return { activeEnvironment, defaults: mergeDefaults(ws?.defaults, us?.defaults), environments };
}
function loadMergedConfig(startDir = process.cwd()) {
    const workspacePath = findWorkspaceConfigPath(startDir);
    const userPath = userConfigPath();
    const workspaceFile = readFileIfExists(workspacePath);
    const userFile = readFileIfExists(userPath);
    const merged = mergeConfigFiles(workspaceFile, userFile);
    const { vars, sources } = loadEnvVars(startDir);
    return { workspacePath, userPath, workspaceFile, userFile, ...merged, env: vars, envSources: sources };
}
/** 递归解析字符串中的 ${VAR} 占位符；缺失则报出全部缺失变量名 */
function resolveEnvPlaceholders(value, env) {
    const missing = new Set();
    const walk = (v) => {
        if (typeof v === 'string') {
            return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
                const val = env[name];
                if (val === undefined) {
                    missing.add(name);
                    return '';
                }
                return val;
            });
        }
        if (Array.isArray(v))
            return v.map(walk);
        if (v !== null && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v)) {
                out[k] = walk(v[k]);
            }
            return out;
        }
        return v;
    };
    const result = walk(value);
    if (missing.size > 0) {
        throw new Error(`密码变量未定义：${[...missing].join(', ')}。请在 .env 文件中定义（工作区 .env 或 ~/.zcode/db-connector/.env，保存即生效无需重启；系统环境变量不参与解析）`);
    }
    return result;
}
/** 解析 "name" 或 "env/name" 引用到具体连接（不解析占位符，调用方按需 resolveEnvPlaceholders） */
function resolveConnectionRef(merged, ref) {
    if (typeof ref !== 'string' || !ref.trim()) {
        throw new Error('connection 参数不能为空');
    }
    let envName;
    let connName;
    const slash = ref.indexOf('/');
    if (slash >= 0) {
        envName = ref.slice(0, slash);
        connName = ref.slice(slash + 1);
    }
    else {
        envName = merged.activeEnvironment ?? '';
        connName = ref;
        if (!envName) {
            throw new Error('未设置活动环境：请在配置中设置 activeEnvironment，或使用 "环境名/连接名" 的完整写法（如 prod/mysql-main）');
        }
    }
    const env = merged.environments[envName];
    if (!env) {
        throw new Error(`环境 "${envName}" 不存在。可用环境：${Object.keys(merged.environments).join(', ') || '（无）'}`);
    }
    const conn = env.connections[connName];
    if (!conn) {
        const available = Object.keys(env.connections).join(', ') || '（无）';
        throw new Error(`连接 "${connName}" 在环境 "${envName}" 中不存在。可用连接：${available}`);
    }
    const effective = {
        rowLimit: conn.rowLimit ?? merged.defaults.rowLimit,
        maxRowLimit: conn.maxRowLimit ?? merged.defaults.maxRowLimit,
        timeoutMs: conn.timeoutMs ?? merged.defaults.timeoutMs,
    };
    return { environment: envName, name: connName, config: conn, envProtected: !!env.protected, effective };
}
/** 校验环境名/连接名标识符 */
function validateIdentifier(kind, value) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
        throw new Error(`${kind} "${value}" 不合法：需以字母或数字开头，仅含字母/数字/-/_，最长 64 字符`);
    }
}
/**
 * 配置工具写入前的清洗：只接受 ${ENV} 形式的 password；type 白名单；
 * URL 内联凭证允许但返回告警（与手工编辑口径一致）。
 */
function sanitizeConnectionForWrite(input, passwordEnvVar) {
    const warnings = [];
    const cfg = { ...input };
    if (passwordEnvVar !== undefined) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordEnvVar)) {
            throw new Error(`passwordEnvVar "${passwordEnvVar}" 不是合法的环境变量名`);
        }
        cfg.password = `\${${passwordEnvVar}}`;
    }
    if (cfg.type !== undefined && !exports.DB_TYPES.includes(cfg.type)) {
        throw new Error(`type 必须是 ${exports.DB_TYPES.join(' / ')} 之一`);
    }
    if (cfg.type === undefined) {
        throw new Error('缺少 type 字段（mysql / postgres / mongodb）');
    }
    if (cfg.password !== undefined && cfg.password !== null) {
        const pw = String(cfg.password);
        if (!ENV_REF_PATTERN.test(pw)) {
            throw new Error('拒绝写入明文密码：请改用 passwordEnvVar 参数传入密码变量名（在 .env 文件中定义，写入为 ${VAR} 引用），或手工编辑文件时写成 "${VAR}"');
        }
    }
    const url = typeof cfg.url === 'string' ? cfg.url : undefined;
    if (url) {
        const inline = url.match(/:\/\/[^/@\s:]+:([^/@\s]*)@/);
        if (inline && !ENV_REF_PATTERN.test(inline[1] || '')) {
            warnings.push('URL 中包含内联密码：建议改用 ${ENV_VAR} 占位符（如 mongodb://user:${DB_PW}@host），当前写法将明文凭证保存在配置文件里');
        }
    }
    delete cfg.passwordEnvVar;
    return { config: cfg, warnings };
}
/** 写入指定 scope 的配置文件 */
function persistAddConnection(scope, merged, envName, connName, config) {
    const file = scope === 'workspace' ? merged.workspacePath : merged.userPath;
    const current = readFileIfExists(file) ?? emptyConfigFile();
    if (!current.environments[envName]) {
        current.environments[envName] = { connections: {} };
    }
    if (current.environments[envName].connections[connName]) {
        throw new Error(`连接 "${envName}/${connName}" 已存在于 ${file}，如需覆盖请先删除`);
    }
    current.environments[envName].connections[connName] = config;
    atomicWrite(file, current);
    return { file };
}
/** 删除连接：优先工作区文件，其次用户级文件 */
function persistRemoveConnection(merged, envName, connName) {
    for (const file of [merged.workspacePath, merged.userPath]) {
        const current = readFileIfExists(file);
        if (!current)
            continue;
        const env = current.environments[envName];
        if (env && env.connections && env.connections[connName]) {
            delete env.connections[connName];
            if (Object.keys(env.connections).length === 0 && !env.description && !env.protected) {
                delete current.environments[envName];
            }
            atomicWrite(file, current);
            return { file };
        }
    }
    throw new Error(`连接 "${envName}/${connName}" 不存在，未做任何修改`);
}
/** 切换活动环境：工作区文件存在则写入工作区，否则写入用户级 */
function persistSetActiveEnvironment(merged, envName) {
    if (!merged.environments[envName]) {
        throw new Error(`环境 "${envName}" 不存在。可用环境：${Object.keys(merged.environments).join(', ') || '（无）'}`);
    }
    const file = merged.workspaceFile ? merged.workspacePath : merged.userPath;
    const current = readFileIfExists(file) ?? emptyConfigFile();
    current.activeEnvironment = envName;
    atomicWrite(file, current);
    return { file };
}
/** 脱敏展示（list 用） */
function maskConnection(conn) {
    const out = { type: conn.type };
    if (conn.database)
        out.database = conn.database;
    if (conn.host)
        out.host = conn.host;
    if (conn.port)
        out.port = conn.port;
    if (conn.user)
        out.user = conn.user;
    if (conn.url) {
        out.url = conn.url.replace(/(:[^/@\s]*)@/, ':***@').replace(/\$\{[^}]+\}/g, '${…}');
    }
    if (conn.password)
        out.password = '${…}';
    return out;
}
