// Ponte: serve o controle para o celular e repassa cada toque para a TV ou o Fire Stick.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig, saveConfig, CONFIG_FILE } from './config.mjs';
import { discover, macOf } from './discover.mjs';
import { LgTv } from './lg.mjs';
import { FireTv, ADB } from './fire.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const SUPPORTED = new Set(['lg', 'fire']);

const config = loadConfig();
/** @type {Map<string, LgTv | FireTv>} */
const drivers = new Map();

function persist() { saveConfig(config); }

function makeDriver(device) {
  const d = device.kind === 'lg'
    ? new LgTv(device, () => persist())
    : new FireTv(device);
  d.on('status', async () => {
    broadcastDevices();
    if (device.kind === 'lg' && d.state === 'conectada' && !device.mac) {
      const mac = await macOf(device.ip);
      if (mac) { device.mac = mac; persist(); }
    }
  });
  drivers.set(device.id, d);
  d.start();
  return d;
}

function deviceView(device) {
  const d = drivers.get(device.id);
  return { id: device.id, kind: device.kind, name: device.name, ip: device.ip, model: device.model, ...(d?.status ?? {}) };
}

// ---- descoberta: acha aparelhos novos e segue os que mudaram de IP ----
let discovering = null;
async function runDiscovery() {
  if (discovering) return discovering;
  discovering = (async () => {
    const found = await discover();
    let changed = false;
    for (const f of found) {
      if (!SUPPORTED.has(f.kind)) continue;
      const known = config.devices.find((d) => (f.udn && d.udn === f.udn) || (d.ip === f.ip && d.kind === f.kind));
      if (known) {
        if (known.ip !== f.ip) {
          known.ip = f.ip;
          changed = true;
          const drv = drivers.get(known.id);
          drv?.stop();
          makeDriver(known);
        }
        if (!known.udn && f.udn) { known.udn = f.udn; changed = true; }
        continue;
      }
      const device = {
        id: `${f.kind}-${(f.udn || f.ip).replace(/[^a-z0-9]/gi, '').slice(-8)}`,
        kind: f.kind,
        name: f.kind === 'lg' ? 'TV LG' : 'Fire Stick',
        ip: f.ip,
        udn: f.udn || undefined,
        model: f.model || undefined,
      };
      config.devices.push(device);
      makeDriver(device);
      changed = true;
    }
    if (changed) { persist(); broadcastDevices(); }
    return found;
  })().finally(() => { discovering = null; });
  return discovering;
}

// ---- HTTP ----
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Não achei.');
  }
});

// ---- WebSocket com o celular ----
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastDevices() {
  const msg = JSON.stringify({ type: 'devices', devices: config.devices.map(deviceView) });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

/** Volume no controle do Fire vai para a TV LG quando ela estiver ligada (é a TV que tem o som). */
function volumeTarget(device, args) {
  if (device.kind !== 'fire' || !['volumeUp', 'volumeDown', 'mute'].includes(args?.key)) return null;
  const tv = config.devices.find((d) => d.kind === 'lg' && drivers.get(d.id)?.state === 'conectada');
  return tv ? drivers.get(tv.id) : null;
}

async function handle(msg) {
  switch (msg.op) {
    case 'discover': {
      const found = await runDiscovery();
      return found.map((f) => ({ ip: f.ip, kind: f.kind, name: f.name, model: f.model }));
    }
    case 'add': {
      const kind = String(msg.kind);
      const ip = String(msg.ip ?? '').trim();
      if (!SUPPORTED.has(kind)) throw new Error('Por enquanto: TV LG ou Fire Stick.');
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('IP inválido');
      if (config.devices.some((d) => d.ip === ip && d.kind === kind)) throw new Error('Esse aparelho já está na lista');
      const device = { id: `${kind}-${ip.replace(/\./g, '')}`, kind, name: kind === 'lg' ? 'TV LG' : 'Fire Stick', ip };
      config.devices.push(device);
      persist();
      makeDriver(device);
      broadcastDevices();
      return deviceView(device);
    }
    case 'rename': {
      const device = config.devices.find((d) => d.id === msg.device);
      if (!device) throw new Error('Aparelho não encontrado');
      device.name = String(msg.name ?? '').trim().slice(0, 30) || device.name;
      persist();
      broadcastDevices();
      return;
    }
    case 'remove': {
      const i = config.devices.findIndex((d) => d.id === msg.device);
      if (i < 0) throw new Error('Aparelho não encontrado');
      drivers.get(msg.device)?.stop();
      drivers.delete(msg.device);
      config.devices.splice(i, 1);
      persist();
      broadcastDevices();
      return;
    }
    case 'reconnect': {
      const drv = drivers.get(msg.device);
      if (!drv) throw new Error('Aparelho não encontrado');
      clearTimeout(drv.retry);
      return drv.connect();
    }
    default: {
      const device = config.devices.find((d) => d.id === msg.device);
      const drv = device && drivers.get(device.id);
      if (!drv) throw new Error('Aparelho não encontrado');
      const tv = volumeTarget(device, msg.args);
      if (tv) {
        return tv.run(msg.args.key === 'mute' ? 'mute' : msg.args.key);
      }
      return drv.run(String(msg.action), msg.args ?? {});
    }
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'devices', devices: config.devices.map(deviceView) }));
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      const data = await handle(msg);
      if (msg.id) ws.send(JSON.stringify({ type: 'reply', id: msg.id, ok: true, data: data ?? null }));
    } catch (e) {
      if (msg.id) ws.send(JSON.stringify({ type: 'reply', id: msg.id, ok: false, error: e.message }));
    }
  });
});

// ---- partida ----
for (const device of config.devices) if (SUPPORTED.has(device.kind)) makeDriver(device);

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('192.168.122.'))
    .map((n) => n.address);
  console.log(`Controle no ar: ${ips.map((ip) => `http://${ip}:${PORT}`).join('  ')}`);
  console.log(`Aparelhos salvos em ${CONFIG_FILE}; adb: ${ADB}`);
  runDiscovery().catch(() => {});
});

// Procura de novo a cada 30 s: acha a TV quando ela é ligada e segue quem trocou de IP.
setInterval(() => { runDiscovery().catch(() => {}); }, 30_000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const d of drivers.values()) d.stop();
    server.close();
    process.exit(0);
  });
}
