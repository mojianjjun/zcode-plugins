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
/**
 * db-connector MCP 服务器入口：stdio 上的 JSON-RPC 2.0（每行一个消息）。
 * 支持 initialize / notifications/* / ping / tools/list / tools/call。
 */
const readline = __importStar(require("readline"));
const tools_1 = require("./tools");
const SERVER_NAME = 'db-connector';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}
function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}
function log(...parts) {
    process.stderr.write(`[db-connector] ${parts.join(' ')}\n`);
}
async function handleMessage(msg) {
    const { method, id, params } = msg;
    // 通知（无 id）：静默接收
    if (id === undefined || id === null) {
        return;
    }
    try {
        switch (method) {
            case 'initialize': {
                const requested = params?.protocolVersion ?? PROTOCOL_VERSION;
                reply(id, {
                    protocolVersion: requested,
                    capabilities: { tools: {} },
                    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                });
                return;
            }
            case 'ping': {
                reply(id, {});
                return;
            }
            case 'tools/list': {
                reply(id, { tools: tools_1.TOOL_DEFINITIONS });
                return;
            }
            case 'tools/call': {
                const name = String(params?.name ?? '');
                const args = params?.arguments ?? {};
                try {
                    const result = await (0, tools_1.handleToolCall)(name, args);
                    reply(id, {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                        isError: false,
                    });
                }
                catch (toolError) {
                    // 工具级错误：按 MCP 惯例返回 isError 内容而非协议错误，AI 可读取原因
                    reply(id, {
                        content: [{ type: 'text', text: `工具执行失败：${toolError.message}` }],
                        isError: true,
                    });
                }
                return;
            }
            default:
                replyError(id, -32601, `Method not found: ${method}`);
        }
    }
    catch (e) {
        replyError(id, -32603, `Internal error: ${e.message}`);
    }
}
async function main() {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
        const text = line.trim();
        if (!text)
            return;
        let msg;
        try {
            msg = JSON.parse(text);
        }
        catch {
            log('忽略无法解析的输入行');
            return;
        }
        if (!msg.method)
            return;
        void handleMessage(msg).catch((e) => log('消息处理异常:', e.message));
    });
    rl.on('close', () => {
        log('stdin 已关闭，服务器退出');
        process.exit(0);
    });
    process.on('uncaughtException', (e) => log('未捕获异常:', e.message));
    process.on('unhandledRejection', (r) => log('未处理的 Promise 拒绝:', String(r)));
}
void main();
