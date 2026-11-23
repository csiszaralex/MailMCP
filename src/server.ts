import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { parseJsonText } from './boundary.js';
import { registerReadTools, type ToolDeps, type ToolScope } from './tools/read-tools.js';

export type { ToolDeps, ToolScope };

const packageSchema = z.object({ name: z.string().min(1), version: z.string().min(1) });

/** Name and version come from package.json (one level above both src/ and dist/). */
export const SERVER_INFO = packageSchema.parse(
  parseJsonText(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
);

/** Builds a fresh server for one request (createMcpHandler calls this per request). */
export function buildMcpServer(scope: ToolScope, deps: ToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerReadTools(server, scope, deps);
  return server;
}
