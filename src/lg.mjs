// TV LG (webOS): WebSocket na porta 3001 (wss, firmwares de 2018 em diante) ou 3000 (antigas).
// Na primeira conexão a TV mostra um aviso "Permitir?"; a chave que ela devolve fica salva.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';
import WebSocket from 'ws';

const PAIRING = JSON.parse(readFileSync(new URL('./lg-pairing.json', import.meta.url), 'utf8'));
// A TV usa um certificado próprio da LG, que nenhuma autoridade pública assina.
const WS_OPTS = { rejectUnauthorized: false, handshakeTimeout: 4000 };

/** Teclas que só existem no "soquete de ponteiro" (o mesmo que a Magic Remote usa). */
export const LG_BUTTONS = new Set([
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'EXIT', 'HOME', 'MENU', 'QMENU', 'INFO', 'GUIDE', 'LIST',
  'DASH', 'ASTERISK', 'CC', 'RED', 'GREEN', 'YELLOW', 'BLUE', 'PLAY', 'PAUSE', 'STOP', 'REWIND', 'FASTFORWARD',
  'RECORD', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE', 'CHANNELUP', 'CHANNELDOWN', 'SAP', 'AD', 'SCREEN_REMOTE',
  'MYAPPS', 'PROGRAM', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

export class LgTv extends EventEmitter {
  /** @param {import('./config.mjs').Device} device */
  constructor(device, onKey) {
    super();
    this.device = device;
    this.onKey = onKey; // salva a chave de pareamento
    this.ws = null;
    this.pointer = null;
    this.state = 'desconectada'; // desconectada | conectando | aguardando-permissao | conectada
    this.seq = 0;
    this.pending = new Map();
    this.retry = null;
    this.stopped = false;
    this.volume = null;
  }

  get status() {
    return { state: this.state, volume: this.volume };
  }

  setState(s) {
    if (this.state !== s) { this.state = s; this.emit('status'); }
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.terminate();
    this.pointer?.terminate();
  }

  scheduleReconnect(ms = 5000) {
    clearTimeout(this.retry);
    if (!this.stopped) this.retry = setTimeout(() => this.connect(), ms);
  }

  async connect() {
    if (this.state === 'conectando' || this.state === 'conectada' || this.state === 'aguardando-permissao') return;
    this.setState('conectando');
    for (const url of [`wss://${this.device.ip}:3001`, `ws://${this.device.ip}:3000`]) {
      const ok = await this.tryUrl(url);
      if (ok) return;
    }
    this.setState('desconectada');
    this.scheduleReconnect();
  }

  tryUrl(url) {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, WS_OPTS);
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.ws = ws;
        this.register();
        resolve(true);
      });
      ws.on('message', (raw) => this.onMessage(raw));
      ws.on('error', () => { if (!opened) resolve(false); });
      ws.on('close', () => {
        if (!opened) return resolve(false);
        if (this.ws === ws) {
          this.ws = null;
          this.pointer?.terminate();
          this.pointer = null;
          for (const p of this.pending.values()) p.reject(new Error('A TV desconectou'));
          this.pending.clear();
          this.setState('desconectada');
          this.scheduleReconnect(3000);
        }
      });
    });
  }

  register() {
    const payload = structuredClone(PAIRING);
    if (this.device.clientKey) payload['client-key'] = this.device.clientKey;
    this.ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload }));
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id === 'register_0') {
      if (msg.type === 'registered') {
        const key = msg.payload?.['client-key'];
        if (key && key !== this.device.clientKey) { this.device.clientKey = key; this.onKey?.(key); }
        this.setState('conectada');
        this.afterConnect();
      } else if (msg.type === 'response' && msg.payload?.pairingType === 'PROMPT') {
        this.setState('aguardando-permissao');
      } else if (msg.type === 'error') {
        // Recusaram na TV, ou a chave salva não vale mais.
        this.device.clientKey = undefined;
        this.ws?.close();
      }
      return;
    }
    if (msg.id === 'volume_sub' && msg.payload) {
      const v = msg.payload.volumeStatus ?? msg.payload;
      if (typeof v.volume === 'number') {
        this.volume = { level: v.volume, muted: Boolean(v.muteStatus ?? v.muted) };
        this.emit('status');
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error' || msg.payload?.returnValue === false) {
      p.reject(new Error(msg.error || msg.payload?.errorText || 'A TV recusou o comando'));
    } else {
      p.resolve(msg.payload ?? {});
    }
  }

  afterConnect() {
    this.ws?.send(JSON.stringify({ type: 'subscribe', id: 'volume_sub', uri: 'ssap://audio/getVolume' }));
  }

  request(uri, payload = {}, timeoutMs = 5000) {
    if (this.state !== 'conectada' || !this.ws) return Promise.reject(new Error('TV desconectada'));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('A TV não respondeu')); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ type: 'request', id, uri, payload }));
    });
  }

  async pointerSocket() {
    if (this.pointer?.readyState === WebSocket.OPEN) return this.pointer;
    const { socketPath } = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    if (!socketPath) throw new Error('A TV não abriu o canal de teclas');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(socketPath, WS_OPTS);
      ws.on('open', () => { this.pointer = ws; resolve(ws); });
      ws.on('error', reject);
      ws.on('close', () => { if (this.pointer === ws) this.pointer = null; });
    });
  }

  async sendPointer(fields) {
    const ws = await this.pointerSocket();
    ws.send(Object.entries(fields).map(([k, v]) => `${k}:${v}`).join('\n') + '\n\n');
  }

  /** Liga pela rede (Wake-on-LAN). Precisa de "Ligar pelo Wi-Fi / LG Connect Apps" ativo na TV. */
  wake() {
    const mac = this.device.mac;
    if (!mac) throw new Error('Ainda não sei o endereço físico da TV. Ligue-a uma vez pelo botão dela.');
    const bytes = Buffer.from(mac.replace(/[^0-9a-f]/gi, ''), 'hex');
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
    const sock = dgram.createSocket('udp4');
    sock.bind(() => {
      sock.setBroadcast(true);
      const bcast = this.device.ip.replace(/\.\d+$/, '.255');
      let left = 0;
      const targets = [[bcast, 9], ['255.255.255.255', 9], [this.device.ip, 9], [bcast, 7]];
      for (let round = 0; round < 3; round++) {
        for (const [host, port] of targets) {
          left++;
          setTimeout(() => sock.send(packet, port, host, () => { if (--left === 0) sock.close(); }), round * 300);
        }
      }
    });
    // Assim que acordar, reconecta.
    setTimeout(() => { if (this.state === 'desconectada') { clearTimeout(this.retry); this.connect(); } }, 2500);
    setTimeout(() => { if (this.state === 'desconectada') { clearTimeout(this.retry); this.connect(); } }, 7000);
  }

  /** Um comando vindo do celular. */
  async run(action, args = {}) {
    switch (action) {
      case 'key': {
        const name = String(args.key).toUpperCase();
        if (!LG_BUTTONS.has(name)) throw new Error(`Tecla desconhecida: ${name}`);
        return this.sendPointer({ type: 'button', name });
      }
      case 'power': {
        if (this.state !== 'conectada') return this.wake();
        const st = await this.request('ssap://com.webos.service.tvpower/power/getPowerState').catch(() => ({}));
        if (st.state === 'Active Standby' || st.state === 'Suspend') {
          return this.request('ssap://com.webos.service.tvpower/power/turnOnScreen').catch(() => this.wake());
        }
        if (st.state === 'Screen Off') return this.request('ssap://com.webos.service.tvpower/power/turnOnScreen');
        return this.request('ssap://system/turnOff');
      }
      case 'screenOff':
        return this.request('ssap://com.webos.service.tvpower/power/turnOffScreen');
      case 'volumeUp':   return this.request('ssap://audio/volumeUp');
      case 'volumeDown': return this.request('ssap://audio/volumeDown');
      case 'setVolume':  return this.request('ssap://audio/setVolume', { volume: Math.max(0, Math.min(100, Number(args.level) || 0)) });
      case 'mute': {
        const muted = this.volume ? !this.volume.muted : true;
        return this.request('ssap://audio/setMute', { mute: muted });
      }
      case 'channelUp':   return this.request('ssap://tv/channelUp');
      case 'channelDown': return this.request('ssap://tv/channelDown');
      case 'inputs': {
        const r = await this.request('ssap://tv/getExternalInputList');
        return (r.devices ?? []).map((d) => ({ id: d.id, label: d.label || d.id, connected: d.connected !== false, icon: d.icon }));
      }
      case 'setInput': return this.request('ssap://tv/switchInput', { inputId: String(args.id) });
      case 'apps': {
        const r = await this.request('ssap://com.webos.applicationManager/listLaunchPoints');
        return (r.launchPoints ?? [])
          .filter((a) => !a.systemApp || /youtube|netflix|amazon|disney|globo|spotify|max|hbo|browser|livetv|photovideo/i.test(a.id))
          .map((a) => ({ id: a.id, title: a.title }));
      }
      case 'launch': return this.request('ssap://system.launcher/launch', { id: String(args.id) });
      case 'play':        return this.request('ssap://media.controls/play');
      case 'pause':       return this.request('ssap://media.controls/pause');
      case 'stop':        return this.request('ssap://media.controls/stop');
      case 'rewind':      return this.request('ssap://media.controls/rewind');
      case 'fastForward': return this.request('ssap://media.controls/fastForward');
      case 'text':  return this.request('ssap://com.webos.service.ime/insertText', { text: String(args.text ?? ''), replace: 0 });
      case 'enter': return this.request('ssap://com.webos.service.ime/sendEnterKey');
      case 'backspace': return this.request('ssap://com.webos.service.ime/deleteCharacters', { count: Number(args.count) || 1 });
      case 'move':
        return this.sendPointer({ type: 'move', dx: Math.round(args.dx) || 0, dy: Math.round(args.dy) || 0, down: 0 });
      case 'click':  return this.sendPointer({ type: 'click' });
      case 'scroll': return this.sendPointer({ type: 'scroll', dx: 0, dy: Math.round(args.dy) || 0 });
      case 'toast':  return this.request('ssap://system.notifications/createToast', { message: String(args.message ?? '') });
      default: throw new Error(`Comando desconhecido: ${action}`);
    }
  }
}
