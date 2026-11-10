// Fire Stick / Fire TV: ADB pela rede (porta 5555). Na primeira vez o Fire pergunta
// "Permitir depuração?" — marque "Sempre permitir deste computador".
// Também serve para projetores e TV boxes Android com ADB aberto (kind 'android'), sem o canal do PIN.
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Lightning } from './fire-lightning.mjs';

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
  { id: 'com.amazon.avod.thirdpartyclient', title: 'Prime Video', color: '#1a98ff' },
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
  { id: 'com.android.chrome', title: 'Chrome', color: '#1a73e8' },
  { id: 'com.mxtech.videoplayer.ad', title: 'MX Player', color: '#1c75bc' },
  { id: 'com.waxrain.airplayer2', title: 'AirPlay', color: '#444' },
  { id: 'com.droidlogic.miracast', title: 'Espelhar tela', color: '#444' },
  { id: 'com.droidlogic.mediacenter', title: 'Mídia', color: '#444' },
];

/** Entradas físicas dos aparelhos Android (TV Input Framework). */
const INPUT_LABEL = { 9: 'HDMI', 3: 'AV', 1: 'Componente', 7: 'VGA' };

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
  constructor(device, onToken) {
    super();
    this.device = device;
    this.onToken = onToken; // salva o token do PIN
    this.mode = null;       // 'adb' | 'pin'
    this.lightning = new Lightning(device.ip, device.fireToken);
    this.state = 'desconectada'; // desconectada | conectando | aguardando-permissao | precisa-pin | conectada
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
    this.isAndroid = device.kind === 'android';
    this.label = this.isAndroid ? 'O projetor' : 'O Fire';
  }

  get serial() { return `${this.device.ip}:5555`; }
  get status() { return { state: this.state, detail: this.detail, mode: this.mode }; }

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
    // 1) ADB, se a depuração estiver ligada (mais teclas).
    try {
      const out = await adb(['connect', this.serial], 6000);
      if (!/refused|failed|unable|cannot/i.test(out)) {
        const state = (await adb(['-s', this.serial, 'get-state']).catch((e) => e.message)).trim();
        if (state === 'device') {
          this.mode = 'adb';
          this.openShell();
          return this.setState('conectada');
        }
        if (/unauthorized/i.test(state)) {
          this.setState('aguardando-permissao', 'Aceite o aviso na TV ("Sempre permitir").');
          return this.scheduleReconnect(3000);
        }
      }
    } catch {}
    if (this.isAndroid) {
      this.mode = null;
      this.setState('desconectada', 'Não achei o ADB. Está ligado, com a depuração por rede ativa?');
      return this.scheduleReconnect(15000);
    }
    // 2) Canal do app oficial, pareado por PIN.
    if (this.lightning.token) {
      const ok = (await this.lightning.reachable()) || (await this.lightning.wake());
      if (ok) {
        this.mode = 'pin';
        return this.setState('conectada');
      }
      this.mode = null;
      this.setState('desconectada', 'O Fire não respondeu. Está ligado?');
      return this.scheduleReconnect(15000);
    }
    this.mode = null;
    this.setState('precisa-pin');
  }

  /** Mostra um PIN na TV. */
  async pairStart() {
    this.lightning.ip = this.device.ip;
    await this.lightning.showPin('Controle');
  }

  async pairVerify(pin) {
    const token = await this.lightning.verifyPin(pin);
    this.device.fireToken = token;
    this.onToken?.(token);
    this.mode = 'pin';
    this.setState('conectada');
  }

  async runPin(action, args) {
    const l = this.lightning;
    const guard = (p) => p.catch((e) => {
      if (e.code === 'TOKEN') { this.device.fireToken = undefined; l.token = undefined; this.onToken?.(undefined); this.mode = null; this.setState('precisa-pin'); }
      throw e;
    });
    switch (action) {
      case 'key': return guard(this.queued(() => l.key(args.long && args.key === 'home' ? 'menu' : args.key)));
      case 'text': return guard(l.text(String(args.text ?? '').slice(0, 200)));
      case 'enter': return guard(this.queued(() => l.key('select')));
      case 'backspace': throw new Error('Para apagar, use o teclado da TV ou ligue a depuração ADB');
      case 'apps': {
        const list = await guard(l.apps());
        const known = new Map(FIRE_APPS.map((a) => [a.id, a]));
        // Os conhecidos (com cor) primeiro; depois o resto em ordem alfabética.
        return list
          .map((a) => ({
            id: a.appId, title: known.get(a.appId)?.title ?? a.name ?? a.appId, color: known.get(a.appId)?.color,
            // Arte oficial do app, servida pela própria Amazon.
            icon: /^https:\/\/[\w.-]+\.media-amazon\.com\//.test(a.tvIconArt ?? '') ? a.tvIconArt : undefined,
            rank: known.has(a.appId) ? FIRE_APPS.findIndex((k) => k.id === a.appId) : 999 }))
          .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title, 'pt-BR'))
          .map(({ rank, ...a }) => a);
      }
      case 'launch': {
        const pkg = String(args.id);
        if (!/^[\w.]+$/.test(pkg)) throw new Error('Pacote inválido');
        return guard(l.launch(pkg));
      }
      default: throw new Error(`Comando desconhecido: ${action}`);
    }
  }

  /** Uma tecla de cada vez; se o dedo segurar, não deixa empilhar atraso. */
  queued(fn) {
    if ((this.pinQueue ?? 0) >= 2) return Promise.resolve();
    this.pinQueue = (this.pinQueue ?? 0) + 1;
    const run = (this.pinChain ?? Promise.resolve()).then(fn).finally(() => { this.pinQueue--; });
    this.pinChain = run.catch(() => {});
    return run;
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
      for (const w of this.waiters) w.reject(new Error(`${this.label} desconectou`));
      this.waiters = [];
      this.busy = false;
      this.queue = [];
      this.setState('desconectada');
      this.scheduleReconnect(2000);
    });
  }

  exec(cmd, timeoutMs = 8000) {
    if (!this.shell) return Promise.reject(new Error(`${this.label} está desconectado`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((x) => x.id === id);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`${this.label} não respondeu`));
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
    if (this.state !== 'conectada') return Promise.reject(new Error(`${this.label} está desconectado`));
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

  /** HDMI/AV do projetor, lidos do TV Input Framework. */
  async inputs() {
    const out = await this.exec('dumpsys tv_input');
    const list = [];
    for (const m of out.matchAll(/TvInputHardwareInfo \{id=\d+, type=(\d+)(?:[^}]*?hdmi_port=(\d+))?[^}]*?cable_connection_status=(\d+)\}, mInfo: TvInputInfo\{id=([^,]+),/g)) {
      const [, type, port, cable, id] = m;
      const name = INPUT_LABEL[type];
      if (!name || list.some((i) => i.id === id)) continue;
      list.push({ id, label: port ? `${name} ${port}` : name, connected: cable === '1' ? true : cable === '2' ? false : null });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true }));
  }

  async setInput(id) {
    if (!/^[\w./]+$/.test(id)) throw new Error('Entrada inválida');
    const uri = `content://android.media.tv/passthrough/${encodeURIComponent(id)}`;
    const out = await this.exec(`am start -a android.intent.action.VIEW -t vnd.android.cursor.item/channel -d '${uri}' 2>&1`);
    // Sem app de TV que aceite o atalho: abre o seletor de entradas do próprio aparelho.
    if (/Error|unable|No Activity/i.test(out)) await this.exec('input keyevent 178');
  }

  async run(action, args = {}) {
    if (action === 'pairStart') return this.pairStart();
    if (action === 'pairVerify') return this.pairVerify(String(args.pin ?? '').trim());
    if (this.state !== 'conectada') throw new Error(`${this.label} está desconectado`);
    if (this.mode === 'pin') return this.runPin(action, args);
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
      case 'inputs': return this.inputs();
      case 'setInput': return this.setInput(String(args.id ?? ''));
      case 'launch': {
        const pkg = String(args.id);
        if (!/^[\w.]+$/.test(pkg)) throw new Error('Pacote inválido');
        // TV boxes costumam ter só a entrada "leanback"; celulares e o Chrome, só a comum.
        return this.exec(`monkey -p ${pkg} -c android.intent.category.LEANBACK_LAUNCHER 1 2>&1 | grep -q 'No activities' && monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
      }
      default: throw new Error(`Comando desconhecido: ${action}`);
    }
  }
}
