// TV LG antiga (NetCast 3/4, 2012–2013): XML por HTTP na porta 8080 ("ROAP").
// Pareamento: a TV mostra uma chave de 6 dígitos; com ela o computador pede uma sessão.
// Ela não liga pela rede (só desliga); para ligar, use o Fire (HDMI-CEC) ou o botão da TV.
import { EventEmitter } from 'node:events';
import http from 'node:http';

const XML = '<?xml version="1.0" encoding="utf-8"?>';

/** Nome da tecla no controle → código NetCast. */
export const NETCAST_KEYS = {
  POWER: 1, '0': 2, '1': 3, '2': 4, '3': 5, '4': 6, '5': 7, '6': 8, '7': 9, '8': 10, '9': 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, ENTER: 20, HOME: 21, MENU: 21, BACK: 23,
  VOLUMEUP: 24, VOLUMEDOWN: 25, MUTE: 26, CHANNELUP: 27, CHANNELDOWN: 28,
  BLUE: 29, GREEN: 30, RED: 31, YELLOW: 32, PLAY: 33, PAUSE: 34, STOP: 35, FASTFORWARD: 36, REWIND: 37,
  RECORD: 40, LIVETV: 43, GUIDE: 44, INFO: 45, RATIO: 46, INPUT: 47, CC: 49, LIST: 50,
  DASH: 402, PREVCH: 403, FAV: 404, QMENU: 405, AD: 407, ENERGY: 409, AVMODE: 410, SIMPLINK: 411, EXIT: 412, APPS: 417,
};

const ACTION_KEYS = {
  power: 'POWER', volumeUp: 'VOLUMEUP', volumeDown: 'VOLUMEDOWN', mute: 'MUTE',
  channelUp: 'CHANNELUP', channelDown: 'CHANNELDOWN', play: 'PLAY', pause: 'PAUSE', stop: 'STOP',
  rewind: 'REWIND', fastForward: 'FASTFORWARD', screenOff: 'ENERGY', enter: 'ENTER',
};

function post(ip, path, body, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(body);
    const req = http.request({
      host: ip, port: 8080, path, method: data ? 'POST' : 'GET', timeout: timeoutMs,
      headers: { 'content-type': 'application/atom+xml', ...(data ? { 'content-length': data.length } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('timeout', () => req.destroy(new Error('A TV não respondeu')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const tag = (xml, t) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1];

export class NetcastTv extends EventEmitter {
  /** @param {import('./config.mjs').Device} device */
  constructor(device, onKey) {
    super();
    this.device = device;
    this.onKey = onKey;
    this.state = 'desconectada'; // desconectada | conectando | precisa-pin | conectada
    this.session = null;
    this.volume = null;
    this.retry = null;
    this.stopped = false;
    this.chain = Promise.resolve();
    this.inFlight = 0;
  }

  get status() { return { state: this.state, volume: this.volume }; }
  setState(s) { if (this.state !== s) { this.state = s; this.emit('status'); } }

  start() { this.stopped = false; this.connect(); }
  stop() { this.stopped = true; clearTimeout(this.retry); }
  scheduleReconnect(ms = 15000) {
    clearTimeout(this.retry);
    if (!this.stopped) this.retry = setTimeout(() => this.connect(), ms);
  }

  async connect() {
    if (this.state === 'conectando') return;
    this.setState('conectando');
    if (!this.device.pairKey) return this.setState('precisa-pin');
    try {
      await this.auth();
      this.setState('conectada');
      this.refreshVolume();
    } catch (e) {
      if (e.code === 'KEY') { this.device.pairKey = undefined; this.onKey?.(); return this.setState('precisa-pin'); }
      this.session = null;
      this.setState('desconectada');
      this.scheduleReconnect();
    }
  }

  async auth() {
    const r = await post(this.device.ip, '/roap/api/auth', `${XML}<auth><type>AuthReq</type><value>${this.device.pairKey}</value></auth>`);
    const session = tag(r.text, 'session');
    if (r.status !== 200 || !session) {
      const err = new Error('A TV recusou a chave. Peça outra.');
      if (r.status === 401) err.code = 'KEY';
      throw err;
    }
    this.session = session;
  }

  async pairStart() {
    const r = await post(this.device.ip, '/roap/api/auth', `${XML}<auth><type>AuthKeyReq</type></auth>`);
    if (r.status !== 200) throw new Error(`A TV não mostrou a chave (${r.status})`);
  }

  async pairVerify(key) {
    const clean = String(key).replace(/\D/g, '');
    if (!clean) throw new Error('Digite a chave que apareceu na TV');
    const previous = this.device.pairKey;
    this.device.pairKey = clean;
    try {
      await this.auth();
    } catch (e) {
      this.device.pairKey = previous;
      throw new Error('Chave não confere. Peça outra.');
    }
    this.onKey?.();
    this.setState('conectada');
    this.refreshVolume();
  }

  async command(type, inner, retry = true) {
    if (!this.session) await this.auth();
    const r = await post(this.device.ip, '/roap/api/command',
      `${XML}<command><session>${this.session}</session><type>${type}</type>${inner}</command>`);
    if (r.status === 401 && retry) { this.session = null; return this.command(type, inner, false); }
    if (r.status !== 200) throw new Error(`A TV respondeu ${r.status}`);
    if (this.state !== 'conectada') this.setState('conectada');
  }

  /** Uma tecla de cada vez; segurar o botão não acumula atraso. */
  key(code) {
    if (this.inFlight >= 2) return Promise.resolve();
    this.inFlight++;
    const p = this.chain.then(() => this.command('HandleKeyInput', `<value>${code}</value>`)).finally(() => { this.inFlight--; });
    this.chain = p.catch(() => {});
    return p.catch((e) => {
      if (/ECONNREFUSED|EHOSTUNREACH|não respondeu|timeout/i.test(e.message)) { this.session = null; this.setState('desconectada'); this.scheduleReconnect(5000); }
      throw e;
    });
  }

  async refreshVolume() {
    try {
      const r = await post(this.device.ip, '/roap/api/data?target=volume_info');
      const level = Number(tag(r.text, 'level'));
      if (r.status === 200 && Number.isFinite(level)) {
        this.volume = { level, muted: tag(r.text, 'mute') === 'true' };
        this.emit('status');
      }
    } catch {}
  }

  async run(action, args = {}) {
    if (action === 'pairStart') return this.pairStart();
    if (action === 'pairVerify') return this.pairVerify(args.pin);
    if (this.state !== 'conectada') {
      if (action === 'power') throw new Error('Esta TV não liga pela rede. Ligue pelo Fire (Início) ou no botão da TV.');
      throw new Error('TV desconectada');
    }
    if (action === 'key') {
      const name = String(args.key).toUpperCase();
      const code = NETCAST_KEYS[name];
      if (code === undefined) throw new Error('Essa tecla não existe nesta TV');
      await this.key(code);
      if (name.startsWith('VOLUME') || name === 'MUTE') setTimeout(() => this.refreshVolume(), 300);
      return;
    }
    if (ACTION_KEYS[action]) {
      await this.key(NETCAST_KEYS[ACTION_KEYS[action]]);
      if (/volume|mute/i.test(action)) setTimeout(() => this.refreshVolume(), 300);
      return;
    }
    switch (action) {
      case 'move': return this.command('HandleTouchMove', `<x>${Math.round(args.dx) || 0}</x><y>${Math.round(args.dy) || 0}</y>`);
      case 'click': return this.command('HandleTouchClick', '');
      case 'scroll': return this.command('HandleTouchWheel', `<value>${(Number(args.dy) || 0) > 0 ? 'down' : 'up'}</value>`);
      default: throw new Error('Esta TV não tem essa função');
    }
  }
}
