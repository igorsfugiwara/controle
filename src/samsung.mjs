// TV Samsung Tizen (2016 em diante): WebSocket "samsung.remote.control".
// 2018+: wss na porta 8002 com token. Na primeira vez a TV pergunta se permite o "Controle".
// Mais antigas (2016–2017): ws na 8001, sem token. Liga pela rede por Wake-on-LAN
// (precisa de "Ligar com dispositivo móvel" ativo na TV).
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import WebSocket from 'ws';

const APP_NAME = Buffer.from('Controle').toString('base64');

/** Nome da tecla no controle (layout da TV) → código Samsung. */
export const SAMSUNG_KEYS = {
  UP: 'KEY_UP', DOWN: 'KEY_DOWN', LEFT: 'KEY_LEFT', RIGHT: 'KEY_RIGHT', ENTER: 'KEY_ENTER',
  BACK: 'KEY_RETURN', HOME: 'KEY_HOME', EXIT: 'KEY_EXIT', MENU: 'KEY_MENU', QMENU: 'KEY_TOOLS',
  INFO: 'KEY_INFO', GUIDE: 'KEY_GUIDE', INPUT: 'KEY_SOURCE', LIST: 'KEY_CH_LIST', DASH: 'KEY_PLUS100',
  RED: 'KEY_RED', GREEN: 'KEY_GREEN', YELLOW: 'KEY_YELLOW', BLUE: 'KEY_CYAN',
  PLAY: 'KEY_PLAY', PAUSE: 'KEY_PAUSE', STOP: 'KEY_STOP', REWIND: 'KEY_REWIND', FASTFORWARD: 'KEY_FF',
  VOLUMEUP: 'KEY_VOLUP', VOLUMEDOWN: 'KEY_VOLDOWN', MUTE: 'KEY_MUTE',
  CHANNELUP: 'KEY_CHUP', CHANNELDOWN: 'KEY_CHDOWN', POWER: 'KEY_POWER', CC: 'KEY_CAPTION',
  ...Object.fromEntries('0123456789'.split('').map((n) => [n, `KEY_${n}`])),
};

const ACTION_KEYS = {
  volumeUp: 'VOLUMEUP', volumeDown: 'VOLUMEDOWN', mute: 'MUTE', channelUp: 'CHANNELUP', channelDown: 'CHANNELDOWN',
  play: 'PLAY', pause: 'PAUSE', stop: 'STOP', rewind: 'REWIND', fastForward: 'FASTFORWARD', enter: 'ENTER',
};

/** Entradas: a Samsung não lista as fontes pelo controle; manda direto a tecla de cada uma. */
const INPUTS = [
  { id: 'KEY_SOURCE', label: 'Escolher na TV (Fonte)' },
  { id: 'KEY_HDMI1', label: 'HDMI 1' }, { id: 'KEY_HDMI2', label: 'HDMI 2' },
  { id: 'KEY_HDMI3', label: 'HDMI 3' }, { id: 'KEY_HDMI4', label: 'HDMI 4' },
  { id: 'KEY_TV', label: 'TV (antena)' },
];

export class SamsungTv extends EventEmitter {
  /**
   * @param {import('./config.mjs').Device} device
   * @param {(token?: string) => void} onToken salva o token e o que mais mudar no aparelho
   * @param {{ http?: number, wss?: number, ws?: number, host?: string }} [ports] só para teste
   */
  constructor(device, onToken, ports = {}) {
    super();
    this.device = device;
    this.onToken = onToken;
    this.ports = { http: 8001, ws: 8001, wss: 8002, ...ports };
    this.state = 'desconectada'; // desconectada | conectando | aguardando-permissao | recusada | conectada
    this.detail = '';
    this.ws = null;
    this.retry = null;
    this.stopped = false;
    this.ime = false;       // teclado da TV aberto
    this.waiters = new Map(); // evento → resolve
  }

  get status() { return { state: this.state, detail: this.detail, volume: null }; }
  setState(s, detail = '') {
    if (this.state !== s || this.detail !== detail) { this.state = s; this.detail = detail; this.emit('status'); }
  }

  start() { this.stopped = false; this.connect(); }
  stop() { this.stopped = true; clearTimeout(this.retry); this.ws?.terminate(); }
  scheduleReconnect(ms = 15000) {
    clearTimeout(this.retry);
    if (!this.stopped) this.retry = setTimeout(() => this.connect(), ms);
  }

  /** Ficha da TV (nome, modelo, MAC, se pede token, se está em standby). */
  async info() {
    const host = this.ports.host ?? this.device.ip;
    const res = await fetch(`http://${host}:${this.ports.http}/api/v2/`, { signal: AbortSignal.timeout(3000) });
    return (await res.json()).device ?? {};
  }

  async connect() {
    if (this.state === 'conectando' || this.state === 'conectada' || this.state === 'aguardando-permissao') return;
    this.setState('conectando');
    let info;
    try { info = await this.info(); } catch {
      this.setState('desconectada');
      return this.scheduleReconnect();
    }
    // Guarda o MAC para ligar pela rede depois.
    const mac = (info.wifiMac ?? '').toLowerCase();
    let changed = false;
    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) && this.device.mac !== mac) { this.device.mac = mac; changed = true; }
    if (info.modelName && !this.device.model) { this.device.model = info.modelName; changed = true; }
    if (changed) this.onToken?.(this.device.samsungToken);
    if (info.PowerState && info.PowerState !== 'on') {
      this.setState('desconectada', 'A TV está em standby.');
      return this.scheduleReconnect(8000);
    }
    this.open(info.TokenAuthSupport === 'true');
  }

  open(secure) {
    const host = this.ports.host ?? this.device.ip;
    const token = this.device.samsungToken ? `&token=${encodeURIComponent(this.device.samsungToken)}` : '';
    const url = secure
      ? `wss://${host}:${this.ports.wss}/api/v2/channels/samsung.remote.control?name=${APP_NAME}${token}`
      : `ws://${host}:${this.ports.ws}/api/v2/channels/samsung.remote.control?name=${APP_NAME}`;
    // O certificado da TV é assinado por ela mesma; a conexão fica só dentro de casa.
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
    this.ws = ws;
    // Sem token, a TV mostra "Permitir?" e só responde quando alguém aceita.
    const askTimer = setTimeout(() => {
      if (this.ws === ws && this.state === 'conectando') this.setState('aguardando-permissao', 'Aceite o aviso na TV (Permitir).');
    }, 1500);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.event) {
        case 'ms.channel.connect': {
          clearTimeout(askTimer);
          const t = msg.data?.token;
          if (t && t !== this.device.samsungToken) { this.device.samsungToken = t; this.onToken?.(t); }
          this.setState('conectada');
          break;
        }
        case 'ms.channel.unauthorized':
          clearTimeout(askTimer);
          this.setState('recusada', 'A TV recusou o Controle.');
          ws.close();
          break;
        case 'ms.channel.timeOut':
          clearTimeout(askTimer);
          this.setState('desconectada', 'Ninguém aceitou o aviso na TV a tempo.');
          ws.close();
          break;
        case 'ms.remote.imeStart': this.ime = true; break;
        case 'ms.remote.imeEnd': this.ime = false; break;
        default: {
          const w = this.waiters.get(msg.event);
          if (w) { this.waiters.delete(msg.event); w(msg); }
        }
      }
    });
    ws.on('close', () => {
      clearTimeout(askTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.ime = false;
      if (this.state !== 'recusada') this.setState('desconectada', this.state === 'desconectada' ? this.detail : '');
      this.scheduleReconnect(this.state === 'recusada' ? 60000 : 5000);
    });
    ws.on('error', () => {}); // o 'close' cuida
  }

  send(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN || this.state !== 'conectada') throw new Error('TV desconectada');
    this.ws.send(JSON.stringify(payload));
  }

  remote(params) { this.send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendRemoteKey', Option: 'false', ...params } }); }

  /**
   * Toque normal = Click. O "voltar" vai como apertar/soltar, igual ao controle físico: muitas
   * Samsung ignoram o Click do KEY_RETURN dentro dos apps (o defeito que os apps de controle têm).
   * backMode 'click' volta ao jeito comum, caso alguma TV prefira.
   */
  key(code, { long = false } = {}) {
    if (long) {
      this.remote({ Cmd: 'Press', DataOfCmd: code });
      return new Promise((r) => setTimeout(() => { try { this.remote({ Cmd: 'Release', DataOfCmd: code }); } catch {} r(); }, 1200));
    }
    if (code === 'KEY_RETURN' && this.device.backMode !== 'click') {
      this.remote({ Cmd: 'Press', DataOfCmd: code });
      return new Promise((r) => setTimeout(() => { try { this.remote({ Cmd: 'Release', DataOfCmd: code }); } catch {} r(); }, 60));
    }
    this.remote({ Cmd: 'Click', DataOfCmd: code });
  }

  waitFor(event, ms = 4000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(event); reject(new Error('A TV não respondeu')); }, ms);
      this.waiters.set(event, (m) => { clearTimeout(t); resolve(m); });
    });
  }

  async apps() {
    const reply = this.waitFor('ed.installedApp.get');
    this.send({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } });
    const list = (await reply).data?.data ?? [];
    this.appTypes = new Map(list.map((a) => [a.appId, a.app_type]));
    return list.map((a) => ({ id: a.appId, title: a.name })).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  }

  launch(id) {
    if (!/^[\w.-]+$/.test(id)) throw new Error('App inválido');
    // app_type 2 = app web (abre por deep link); os outros são nativos.
    const actionType = this.appTypes?.get(id) === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH';
    this.send({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: id, action_type: actionType } } });
  }

  text(text) {
    if (!this.ime) throw new Error('Abra antes o campo de texto na TV (a busca, por exemplo).');
    const t = String(text ?? '').slice(0, 200);
    this.send({ method: 'ms.remote.control', params: { Cmd: Buffer.from(t).toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' } });
    this.send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } });
  }

  mouse(params) { this.send({ method: 'ms.remote.control', params: { TypeOfRemote: 'ProcessMouseDevice', ...params } }); }

  /** Liga pela rede (Wake-on-LAN). */
  wake() {
    const mac = this.device.mac;
    if (!mac) throw new Error('Ainda não sei o endereço físico da TV. Ligue-a uma vez pelo botão dela.');
    const bytes = Buffer.from(mac.replace(/[^0-9a-f]/gi, ''), 'hex');
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
    const sock = dgram.createSocket('udp4');
    sock.bind(() => {
      sock.setBroadcast(true);
      const bcast = this.device.ip.replace(/\.\d+$/, '.255');
      const targets = [[bcast, 9], ['255.255.255.255', 9], [this.device.ip, 9]];
      let left = targets.length * 3;
      for (let round = 0; round < 3; round++) {
        for (const [host, port] of targets) setTimeout(() => sock.send(packet, port, host, () => { if (--left === 0) sock.close(); }), round * 300);
      }
    });
    for (const ms of [3000, 8000]) setTimeout(() => { if (this.state === 'desconectada') { clearTimeout(this.retry); this.connect(); } }, ms);
  }

  async run(action, args = {}) {
    if (action === 'power') {
      if (this.state === 'conectada') return this.key('KEY_POWER');
      return this.wake();
    }
    if (this.state !== 'conectada') throw new Error('TV desconectada');
    if (action === 'key') {
      const name = String(args.key).toUpperCase();
      const code = SAMSUNG_KEYS[name];
      if (!code) throw new Error('Essa tecla não existe nesta TV');
      return this.key(code, { long: Boolean(args.long) });
    }
    if (ACTION_KEYS[action]) return this.key(SAMSUNG_KEYS[ACTION_KEYS[action]]);
    switch (action) {
      case 'inputs': return INPUTS.map((i) => ({ ...i, connected: null }));
      case 'setInput': {
        const input = INPUTS.find((i) => i.id === args.id);
        if (!input) throw new Error('Entrada inválida');
        return this.key(input.id);
      }
      case 'apps': return this.apps();
      case 'launch': return this.launch(String(args.id));
      case 'text': return this.text(args.text);
      case 'move': return this.mouse({ Cmd: 'Move', Position: { x: Math.round(args.dx) || 0, y: Math.round(args.dy) || 0, Time: String(Date.now()) } });
      case 'click': return this.mouse({ Cmd: 'LeftClick' });
      case 'scroll': return this.key((Number(args.dy) || 0) > 0 ? 'KEY_DOWN' : 'KEY_UP');
      default: throw new Error('Esta TV não tem essa função');
    }
  }
}
