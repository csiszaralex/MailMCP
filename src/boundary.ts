/* eslint-disable no-restricted-syntax -- the single boundary where raw JSON/YAML enters a zod schema */
import { parse as parseYaml } from 'yaml';

export function parseJsonText(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function parseYamlText(text: string): unknown {
  return parseYaml(text) as unknown;
}
