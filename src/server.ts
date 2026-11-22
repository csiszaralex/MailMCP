import { McpServer } from '@modelcontextprotocol/server';
import { registerReadTools, type ToolDeps, type ToolScope } from './tools/read-tools.js';

export type { ToolDeps, ToolScope };

export const SERVER_INFO = { name: 'mailmcp', version: '0.1.0' } as const;

/** Builds a fresh server for one request (createMcpHandler calls this per request). */
export function buildMcpServer(scope: ToolScope, deps: ToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerReadTools(server, scope, deps);
  return server;
}
