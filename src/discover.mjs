// Acha TVs e Fire Sticks na rede por SSDP (o mesmo grito que o celular dá para "transmitir").
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';

const SEARCH_TARGETS = [
  'urn:lge-com:service:webos-second-screen:1', // TVs LG webOS
  'urn:dial-multiscreen-org:service:dial:1',   // Fire TV, LG, Samsung, Android TV…
  'urn:samsung.com:device:RemoteControlReceiver:1',
  'roku:ecp',
];

/**
 * @typedef {{ ip: string, kind: 'lg' | 'fire' | 'samsung' | 'roku' | 'outro',
 *   name: string, manufacturer: string, model: string, udn: string }} Found
 */

/** @returns {Promise<Found[]>} */
export async function discover(timeoutMs = 3000) {
  const locations = new Map(); // ip -> Set<location>
  const sts = new Map();       // ip -> Set<st>

  await new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => { try { sock.close(); } catch {} resolve(); });
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const loc = /^LOCATION:\s*(.+)$/im.exec(text)?.[1]?.trim();
      const st = /^ST:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
      if (!locations.has(rinfo.address)) locations.set(rinfo.address, new Set());
      if (!sts.has(rinfo.address)) sts.set(rinfo.address, new Set());
      if (loc) locations.get(rinfo.address).add(loc);
      sts.get(rinfo.address).add(st);
    });
    sock.bind(0, () => {
      for (const st of SEARCH_TARGETS) {
        const m = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
        );
        sock.send(m, 1900, '239.255.255.250');
        setTimeout(() => { try { sock.send(m, 1900, '239.255.255.250'); } catch {} }, 400);
      }
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(); }, timeoutMs);
  });

  const found = [];
  for (const [ip, locs] of locations) {
    let info = { name: '', manufacturer: '', model: '', udn: '' };
    let raw = '';
    for (const loc of locs) {
      const desc = await describe(loc);
      raw += desc.raw;
      if (!info.manufacturer && (desc.manufacturer || desc.name)) info = desc;
    }
    delete info.raw;
    const stList = [...(sts.get(ip) ?? [])].join(' ');
    const maker = info.manufacturer.toLowerCase();
    let kind = 'outro';
    if (stList.includes('lge-com')) kind = 'lg';
    else if (/^lg\b/.test(maker) || /netcast|LGE_DLNA/i.test(raw)) kind = 'netcast'; // LG de 2012–2013
    else if (maker.includes('amazon')) kind = 'fire';
    else if (maker.includes('samsung')) kind = 'samsung';
    else if (stList.includes('roku') || maker.includes('roku')) kind = 'roku';
    // Roteadores e afins respondem ssdp também; só interessam aparelhos de TV.
    if (kind === 'outro' && !stList.includes('dial')) continue;
    found.push({ ip, kind, ...info, name: info.name || ip });
  }
  return found;
}

async function describe(location) {
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(2000) });
    const xml = await res.text();
    const tag = (t) => new RegExp(`<${t}>([^<]*)</${t}>`, 'i').exec(xml)?.[1]?.trim() ?? '';
    return {
      name: decode(tag('friendlyName')),
      manufacturer: decode(tag('manufacturer')),
      model: decode(tag('modelName')),
      udn: tag('UDN'),
      raw: xml,
    };
  } catch {
    return { name: '', manufacturer: '', model: '', udn: '', raw: '' };
  }
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

/** MAC do aparelho pela tabela ARP (precisa ter falado com ele há pouco). */
export function macOf(ip) {
  return new Promise((resolve) => {
    execFile('ip', ['neigh', 'show', ip], (err, out) => {
      resolve(err ? undefined : /lladdr\s+([0-9a-f:]{17})/i.exec(out)?.[1]?.toLowerCase());
    });
  });
}
