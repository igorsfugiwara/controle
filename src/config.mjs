// Aparelhos conhecidos ficam num JSON fora do repositório (tem a chave de pareamento da TV).
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const CONFIG_FILE =
  process.env.CONTROLE_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'controle', 'aparelhos.json');

/**
 * @typedef {{
 *   id: string, kind: 'lg' | 'fire', name: string, ip: string,
 *   udn?: string, mac?: string, clientKey?: string, model?: string
 * }} Device
 */

/** @returns {{ devices: Device[] }} */
export function loadConfig() {
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return { devices: Array.isArray(data.devices) ? data.devices : [] };
  } catch {
    return { devices: [] };
  }
}

/** @param {{ devices: Device[] }} config */
export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, CONFIG_FILE);
}
