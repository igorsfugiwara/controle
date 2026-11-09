// Fire Stick / Fire TV: ADB pela rede (porta 5555). Na primeira vez o Fire pergunta
// "Permitir depuração?" — marque "Sempre permitir deste computador".
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOCAL_ADB = join(homedir(), '.local/share/controle/platform-tools/adb');
export const ADB = process.env.ADB ?? (existsSync(LOCAL_ADB) ? LOCAL_ADB : 'adb');

/** Códigos de tecla do Android. */
export const FIRE_KEYS = {
  up: 19, down: 20, left: 21, right: 22, select: 23,
  back: 4, home: 3, menu: 82, settings: 176,
  playPause: 85, rewind: 89, fastForward: 90, next: 87, previous: 88,
  volumeUp: 24, volumeDown: 25, mute: 164,
  power: 26, sleep: 223, wakeup: 224,
  search: 84, guide: 172, channelUp: 166, channelDown: 167, captions: 175,
  del: 67, enter: 66,
};

/** Atalhos de app (o pacote só aparece no controle se estiver instalado no Fire). */
export const FIRE_APPS = [
  { id: 'com.netflix.ninja', title: 'Netflix', color: '#e50914' },
  { id: 'com.amazon.firebat', title: 'Prime Video', color: '#1a98ff' },
  { id: 'com.amazon.avod', title: 'Prime Video', color: '#1a98ff' },
  { id: 'com.amazon.firetv.youtube', title: 'YouTube', color: '#ff0000' },
  { id: 'com.google.android.youtube.tv', title: 'YouTube', color: '#ff0000' },
  { id: 'com.disney.disneyplus', title: 'Disney+', color: '#113ccf' },
  { id: 'com.wbd.stream', title: 'Max', color: '#002be7' },
  { id: 'com.hbo.hbonow', title: 'Max', color: '#002be7' },
  { id: 'com.globo.globotv', title: 'Globoplay', color: '#ff2a3b' },
  { id: 'com.spotify.tv.android', title: 'Spotify', color: '#1db954' },
  { id: 'com.amazon.rialto', title: 'Amazon Music', color: '#25d1da' },
  { id: 'com.cbs.ca', title: 'Paramount+', color: '#0064ff' },
  { id: 'tv.pluto.android', title: 'Pluto TV', color: '#fff200' },
  { id: 'com.apple.atve.amazon.appletv', title: 'Apple TV', color: '#555' },
  { id: 'org.xbmc.kodi', title: 'Kodi', color: '#17b2e7' },
  { id: 'com.stremio.one', title: 'Stremio', color: '#7b5bf5' },
];

function adb(args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(ADB, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}

export class FireTv extends EventEmitter {
  /** @param {import('./config.mjs').Device} device */
  constructor(device) {
    super();
    this.device = device;
    this.state = 'desconectada'; // desconectada | conectando | aguardando-permissao | sem-adb | conectada
    this.detail = '';
    this.shell = null;
    this.buffer = '';
    this.waiters = [];
    this.queue = [];   // códigos de tecla aguardando
    this.busy = false;
    this.seq = 0;
    this.retry = null;
    this.stopped = false;
    this.installed = null;
  }

  get serial() { return `${this.device.ip}:5555`; }
  get status() { return { state: this.state, detail: this.detail }; }

  setState(s, detail = '') {
    if (this.state !== s || this.detail !== detail) { this.state = s; this.detail = detail; this.emit('status'); }
  }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.shell?.kill();
  }

  scheduleReconnect(ms = 6000) {
    clearTimeout(this.retry);
    if (!this.stopped) this.retry = setTimeout(() => this.connect(), ms);
  }

  async connect() {
    if (this.state === 'conectando' || this.state === 'conectada') return;
    this.setState('conectando');
    try {
      const out = await adb(['connect', this.serial], 10000);
      if (/refused|failed|unable|cannot/i.test(out)) {
        this.setState('sem-adb', 'O Fire recusou. A depuração ADB está ligada?');
        return this.scheduleReconnect(10000);
      }
      const state = (await adb(['-s', this.serial, 'get-state']).catch((e) => e.message)).trim();
      if (/unauthorized/i.test(state)) {
        this.setState('aguardando-permissao', 'Aceite o aviso na TV ("Sempre permitir").');
        return this.scheduleReconnect(3000);
      }
      if (state !== 'device') {
        this.setState('desconectada', state);
        return this.scheduleReconnect();
      }
      this.openShell();
      this.setState('conectada');
    } catch (e) {
      this.setState('desconectada', e.message);
      this.scheduleReconnect();
    }
  }

  openShell() {
    const sh = spawn(ADB, ['-s', this.serial, 'shell'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.shell = sh;
    this.buffer = '';
    sh.stdout.on('data', (d) => {
      this.buffer += d.toString();
      let m;
      while ((m = /__OK_(\d+)__/.exec(this.buffer))) {
        const id = Number(m[1]);
        const out = this.buffer.slice(0, m.index);
        this.buffer = this.buffer.slice(m.index + m[0].length);
        const w = this.waiters.findIndex((x) => x.id === id);
        if (w >= 0) this.waiters.splice(w, 1)[0].resolve(out);
      }
    });
    sh.on('exit', () => {
      if (this.shell !== sh) return;
      this.shell = null;
      for (const w of this.waiters) w.reject(new Error('O Fire desconectou'));
      this.waiters = [];
      this.busy = false;
      this.queue = [];
      this.setState('desconectada');
      this.scheduleReconnect(2000);
    });
  }

  exec(cmd, timeoutMs = 8000) {
    if (!this.shell) return Promise.reject(new Error('Fire desconectado'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((x) => x.id === id);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('O Fire não respondeu'));
      }, timeoutMs);
      this.waiters.push({
        id,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.shell.stdin.write(`${cmd}; echo __OK_${id}__\n`);
    });
  }

  /** Teclas vão numa fila; se o celular mandar várias seguidas, saem juntas num só comando. */
  pressKey(code, { long = false } = {}) {
    if (this.state !== 'conectada') return Promise.reject(new Error('Fire desconectado'));
    if (long) return this.exec(`input keyevent --longpress ${code}`);
    if (this.queue.length >= 8) return Promise.resolve(); // não acumula atraso
    this.queue.push(code);
    this.drain();
    return Promise.resolve();
  }

  async drain() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const batch = this.queue.splice(0, this.queue.length);
    try { await this.exec(`input keyevent ${batch.join(' ')}`); } catch {}
    this.busy = false;
    this.drain();
  }

  async apps() {
    if (!this.installed) {
      const out = await this.exec('pm list packages');
      this.installed = new Set(out.split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean));
    }
    const seen = new Set();
    return FIRE_APPS.filter((a) => {
      if (!this.installed.has(a.id) || seen.has(a.title)) return false;
      seen.add(a.title);
      return true;
    });
  }

  async run(action, args = {}) {
    switch (action) {
      case 'key': {
        const code = FIRE_KEYS[args.key];
        if (code === undefined) throw new Error(`Tecla desconhecida: ${args.key}`);
        return this.pressKey(code, { long: Boolean(args.long) });
      }
      case 'text': {
        // `input text` não aceita espaço direto: vira %s. O resto vai entre aspas simples.
        const t = String(args.text ?? '').slice(0, 200).replace(/ /g, '%s').replace(/'/g, `'\\''`);
        if (t) await this.exec(`input text '${t}'`);
        return;
      }
      case 'backspace': {
        const n = Math.min(50, Number(args.count) || 1);
        return this.exec(`input keyevent ${Array(n).fill(67).join(' ')}`);
      }
      case 'enter': return this.pressKey(66);
      case 'apps': return this.apps();
      case 'launch': {
        const pkg = String(args.id);
        if (!/^[\w.]+$/.test(pkg)) throw new Error('Pacote inválido');
        return this.exec(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
      }
      default: throw new Error(`Comando desconhecido: ${action}`);
    }
  }
}
