# db-connector 插件需求文档

> 版本：v0.5（实现中需求稿，对应插件 0.1.x）
> 日期：2026-11-11
> 目标平台：ZCode Desktop
>
> 变更记录：
> - v0.2：移除 SQLite；行数/超时三层可配置
> - v0.3：面向插件市场发布；连接配置改为**会话式配置工具**（界面配置的落地方式，见 §7）；新增**多环境**支持
> - v0.4（插件 0.1.1）：新增 **.env 密码文件**支持
> - v0.5（插件 0.1.2）：**移除系统环境变量参与密码解析**——`${VAR}` 仅从 .env 文件解析（优先级：工作区 `.env` > 用户级 `~/.zcode/db-connector/.env`）

## 1. 概述

`db-connector` 是一个 ZCode 插件，让 AI 在会话中**安全地连接用户数据库，执行只读查询与结构浏览**。

- 形式：**MCP 服务器（stdio）+ Skill 指导文档**
- 权限：**只读**——不提供任何写入/结构变更能力
- 支持数据库：**MySQL / MariaDB、PostgreSQL、MongoDB**
- 连接管理：**多环境多连接**，支持 dev/test/prod 等环境分组，每个环境可混合多种数据库；通过**会话式配置工具**增删连接并持久化，敏感凭证只以环境变量占位符形式存储
- 分发：本地测试市场验证 → 按 ZCode 官方插件市场流程提交发布（发布为人工外部步骤）

## 2. 用户场景

| # | 场景 | 示例指令 | 预期行为 |
|---|------|---------|---------|
| 1 | 首次配置 | "帮我加一个本地 MySQL 连接，密码放环境变量 DB_DEV_PW 里" | AI 调用 `db_add_connection` 写入配置，返回测试结果 |
| 2 | 查数据 | "查一下 users 表最近注册的 10 个用户" | AI 选活动环境连接，`db_query`（参数绑定）返回行数据 |
| 3 | 看结构 | "列出库里所有表，再看下 orders 的建表信息" | `db_list_tables` → `db_describe_table` |
| 4 | 跨环境对比 | "对比 dev 和 prod 的 users 表结构" | AI 用 `dev/mysql-main`、`prod/mysql-main` 限定名分别查询 |
| 5 | 连通排查 | "prod 的库连得上吗" | `db_test_connection` 返回版本与耗时，结果带生产环境提示条 |

**验收示例（冒烟与试用统一用例）**：
> "用 db-connector 帮我添加一个 MySQL 连接：环境 dev、名字 mysql-main、库 shop，密码用环境变量 DB_DEV_PW。加完列一下所有连接。"

预期：`db_add_connection` 持久化成功 → `db_list_connections` 按 environment 分组返回刚添加的连接（实测需本机可用数据库实例；无实例时配置写入与列表仍可验证）。

## 3. 插件结构（交付物）

```text
plugins/db-connector/
  .zcode-plugin/plugin.json        # name: db-connector, version: 0.1.0
  .mcp.json                        # 声明 MCP 服务器（node db-connect-server）
  mcp/                             # MCP 服务器源码（Node.js stdio）
    db-connect-server.js           # 入口 + 工具实现
    package.json                   # 依赖: mysql2, pg, mongodb
  skills/db-connector/SKILL.md     # 指导 AI 安全使用这些工具（含首次配置引导）
  README.md                        # 安装、配置格式、安全说明（面向市场发布）
plugins/marketplace.json           # 本地测试市场目录
```

- MCP 服务器为 Node.js 脚本，使用 `${CLAUDE_PLUGIN_ROOT}` 定位，依赖安装于插件目录内
- 三个驱动均为**纯 JS 实现，无原生编译依赖**
- **面向发布的要求**：插件目录内不出现工作区绝对路径、不内嵌任何密钥；市场元数据完整（displayName、中英 i18n、category: developer-tools）；图标按规范省略（无 HTTPS 资源时不虚构）；遵循语义化版本
- 交付时检查本机 Node 可用性；若不可用，MCP 部分标记为"待验证"并说明

## 4. 配置规范（多环境多数据库）

### 4.1 配置文件位置与合并

| 层级 | 路径 | 用途 |
|------|------|------|
| 工作区级 | `<workspace>/db-connections.json` | 项目相关连接，可提交 git（不含明文密码） |
| 用户级 | `~/.zcode/db-connector/connections.json` | 跨项目复用的全局连接 |

- 两文件可并存：按 `环境名 + 连接名` 合并，**工作区优先**；`defaults`、`activeEnvironment` 冲突时工作区优先
- 均不存在时，`db_list_connections` 返回引导创建的提示（配合 `db_add_connection`）

### 4.2 文件格式

```json
{
  "configVersion": 1,
  "activeEnvironment": "dev",
  "defaults": { "rowLimit": 200, "maxRowLimit": 1000, "timeoutMs": 10000 },
  "environments": {
    "dev": {
      "description": "本地开发",
      "connections": {
        "mysql-main": {
          "type": "mysql", "host": "localhost", "port": 3306,
          "user": "root", "password": "${DB_DEV_PW}", "database": "shop"
        },
        "pg-analytics": {
          "type": "postgres",
          "url": "postgresql://report:${DB_PG_PW}@10.0.0.8:5432/analytics"
        }
      }
    },
    "prod": {
      "description": "生产环境",
      "protected": true,
      "connections": {
        "mysql-main": { "type": "mysql", "host": "10.0.0.2", "user": "ro_user",
          "password": "${DB_PROD_PW}", "database": "shop" },
        "mongo-logs": { "type": "mongodb",
          "url": "mongodb://user:${DB_MONGO_PW}@host:27017/logs" }
      }
    }
  }
}
```

规则：
- `type` ∈ `mysql | postgres | mongodb`（mysql 兼容 MariaDB）
- 密码/URL 凭证支持 `${VAR}` 占位符，运行时**仅从 .env 文件**解析（优先级：工作区 `.env` > 用户级 `~/.zcode/db-connector/.env`；系统环境变量不参与，避免进程列表泄露与 setx 重启问题）；.env 支持注释/引号/行内注释/export，每次调用重读即生效；未定义时报错并指出变量名与 .env 定义方式
- `protected: true` 的环境：查询结果附带醒目的"生产/受保护环境"提示条（只读插件不做硬拦截）
- `activeEnvironment` 是工具的默认环境，可被 `db_set_active_environment` 修改

### 4.3 环境寻址

- 工具的 `connection` 参数两种写法：`"mysql-main"`（活动环境）或 `"prod/mysql-main"`（显式跨环境）
- `db_list_connections` 按环境分组返回，标注活动环境与 protected 标记

### 4.4 行数与超时：三层可配置

| 层级 | 字段 | 说明 |
|------|------|------|
| 全局默认 | `defaults.rowLimit`（缺省 200）、`defaults.timeoutMs`（缺省 10000） | 所有连接基准值 |
| 连接覆盖 | 连接对象内 `rowLimit` / `timeoutMs` | 覆盖全局默认 |
| 查询临时 | 工具参数 `limit` | 生效值 = min(调用值, maxRowLimit) |

`maxRowLimit`（全局或连接级可配，缺省 1000）为单次返回行数**硬上限**；超限截断并在结果中注明实际行数与是否截断。

## 5. MCP 工具清单（10 个）

**查询类**

| 工具 | 参数 | 说明 |
|------|------|------|
| `db_list_connections` | — | 按环境分组列出连接（凭证脱敏，标注活动环境/protected） |
| `db_test_connection` | `connection` | 测试连通性，返回服务器版本与耗时 |
| `db_list_tables` | `connection` | 列出表（Mongo 为集合）及行数估计 |
| `db_describe_table` | `connection`, `table` | 列名/类型/可空/键/索引；Mongo 采样文档推断字段 + 索引列表 |
| `db_query` | `connection`, `sql`, `params?`, `limit?` | SQL 只读查询，值只能经 `params` 绑定 |
| `db_find` | `connection`, `collection`, `filter?`, `projection?`, `sort?`, `limit?` | MongoDB 只读查询 |
| `db_aggregate` | `connection`, `collection`, `pipeline`, `limit?` | MongoDB 聚合管道（仅读阶段，拒绝 $out/$merge） |

**配置管理类（会话式配置界面）**

| 工具 | 参数 | 说明 |
|------|------|------|
| `db_add_connection` | `environment`, `name`, `config`, `passwordEnvVar?`, `scope?` | 新增连接并持久化；密码只接受环境变量名，写入为 `${VAR}` 引用 |
| `db_remove_connection` | `environment`, `name`, `scope?` | 删除连接 |
| `db_set_active_environment` | `environment` | 切换活动环境并持久化 |

- `scope` ∈ `workspace | user`，缺省 `workspace`
- `db_add_connection` **拒绝**非 `${...}` 占位符的 `password` 字段值（不接受明文密码入参），URL 内联凭证允许但返回告警提示（与手工编辑文件口径一致）

## 6. 安全需求（硬性验收条件）

1. **参数绑定强制**：所有外部输入值必须使用驱动参数绑定；服务器代码**不得**用拼接、模板字符串、format 等方式把值组装进 SQL。`db_query` 的 `params` 是值的唯一通道。
2. **只读语句白名单校验**：SQL 执行前做单语句 + 语句类型校验，仅放行 `SELECT / WITH / EXPLAIN / SHOW / DESCRIBE / DESC`；拦截多语句与一切写/DDL 关键词（即使出现在子查询/注释中也拒绝）。
3. **Mongo 白名单**：仅 `find / aggregate(读阶段) / count / distinct`；`$out`、`$merge` 拒绝。
4. **凭证不落盘明文**：配置工具只写 `${ENV}` 引用；工具返回与日志中脱敏；配置文件手工编辑时明文密码给告警提示。
5. **资源保护**：行数/超时按 §4.4 配置生效，`maxRowLimit` 硬上限。
6. **持久化安全**：配置写入仅限 §4.1 两个白名单路径，防止路径注入；写入采用原子替换。

## 7. 配置交互形态说明（重要约束）

ZCode 插件清单（plugin.json）提供 skills / commands / hooks / MCP 四种组件，**不提供自定义原生设置面板**；官方插件的配置惯例为"setup 技能 + MCP 工具"的会话式配置。因此"界面配置"落地为：

- **会话即界面**：用户用自然语言描述连接信息 → AI 调用 `db_add_connection` 等工具完成配置，全程在对话中完成并即时反馈测试结果
- **首次引导**：Skill 包含零配置首次使用流程，主动引导用户走 `db_add_connection`
- **文件直编**：高级用户可直接编辑 §4.1 两个 JSON 文件
- 若宿主后续在"设置 → 插件"提供 MCP 环境变量配置入口，`${ENV}` 凭证可经该入口注入（宿主能力，不作为本插件验收项）

## 8. Skill 内容要点（skills/db-connector/SKILL.md）

- **何时触发**：用户提到查数据、看表结构、连数据库、配置连接、多环境对比等
- **首次配置流程**：无配置时引导 `db_add_connection`（环境名、连接名、类型、地址、密码环境变量名）→ `db_test_connection` 验证
- **标准查询流程**：`db_list_connections` 确认连接 → （跨环境用 `env/name`）→ `db_list_tables` → `db_describe_table` → 查询
- **规范**：值一律走 `params`；大结果集主动下调 `limit`；建议用户为每个环境使用只读账号；protected 环境结果需向用户明示
- **错误处理**：连接失败/环境变量缺失时，向用户复述缺失项而不是重试

## 9. 验收标准

- [x] `plugin.json` 通过文件级校验：名称/目录一致、路径不越界、无未替换占位符（11 项通过）
- [x] 发布就绪检查：README 完整、市场元数据（displayName/i18n/category）齐备、插件内无绝对路径与密钥
- [x] Node 可用时：MCP 服务器可启动、完成握手、返回 10 个非空工具定义
- [x] 语句校验单测（无需真实数据库）：`UPDATE/DELETE/DROP/INSERT` 及多语句、注释注入均被拒绝（冒烟 26 项通过）
- [x] 配置工具单测：`db_add_connection` 拒绝明文密码、持久化路径白名单、环境合并优先级正确
- [x] 真实 MySQL 实测（2026-11-11，MySQL 8.0.27，`test/real-mysql.mjs` 19 项通过：连通/列表/结构/参数绑定/注入载荷/聚合/三层行数/写语句拒绝/protected 提示/数据零改动）；PostgreSQL 与 MongoDB 暂无实例，未验证
- [x] `marketplace.json` 条目与插件清单名称/版本/路径一致

## 10. 非目标（本版明确排除）

- 原生设置面板（平台不提供，见 §7）
- 写操作与 DDL（未来版本可加显式确认机制）
- SSH 隧道 / 云 IAM 认证
- Redis 等缓存型数据库、SQLite（v0.2 移除）
- 连接池可视化、查询结果图表
- 自动提交官方市场（发布动作由用户按市场方流程人工完成）

## 11. 实现备注

- 运行时：Node.js ≥ 18；依赖 `mysql2`、`pg`、`mongodb`，全部纯 JS
- 凭证变量统一在 .env 文件维护（工作区/用户级），不依赖操作系统环境变量与 ZCode 进程继承
- 用户编码规范：实现优先 TypeScript（MCP 入口编译为单文件 JS 随插件分发，不要求使用者装 tsc）
- 发布路径：本地测试市场验证通过 → 用户通过 ZCode 官方插件市场的提交渠道发布（外部流程，本交付提供发布就绪的完整包）
