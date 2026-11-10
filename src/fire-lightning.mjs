// Canal do app oficial da Amazon para o Fire TV: HTTPS na porta 8080, pareado com um PIN
// que aparece na TV. Não precisa de depuração ADB. O serviço só fica de pé enquanto o
// "FireTVRemote" (DIAL, porta 8009) está rodando; quando o Fire dorme, é preciso acordá-lo.
import https from 'node:https';
import http from 'node:http';

const API_KEY = '0987654321'; // chave fixa do app; o segredo de cada aparelho é o token do PIN
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true }); // certificado próprio do Fire

/** Teclas do controle → ação no Fire. */
export const LIGHTNING_KEYS = {
  up: ['nav', 'dpad_up'], down: ['nav', 'dpad_down'], left: ['nav', 'dpad_left'], right: ['nav', 'dpad_right'],
  select: ['nav', 'select'], back: ['nav', 'back'], home: ['nav', 'home'], menu: ['nav', 'menu'],
  volumeUp: ['nav', 'volume_up'], volumeDown: ['nav', 'volume_down'], mute: ['nav', 'mute'],
  power: ['nav', 'sleep'], sleep: ['nav', 'sleep'],
  playPause: ['media', 'play'], rewind: ['scan', 'back'], fastForward: ['scan', 'forward'],
};

function request(method, url, { headers = {}, body, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request(u, {
      method,
      agent: u.protocol === 'https:' ? agent : undefined,
      headers: { ...headers, ...(data ? { 'content-length': data.length } : { 'content-length': 0 }) },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export class Lightning {
  constructor(ip, token) {
    this.ip = ip;
    this.token = token;
    this.lastOk = 0;
  }

  headers(withToken = true) {
    return {
      'x-api-key': API_KEY,
      'content-type': 'application/json',
      'user-agent': 'okhttp/4.10.0',
      ...(withToken && this.token ? { 'x-client-token': this.token } : {}),
    };
  }

  async wake() {
    await request('POST', `http://${this.ip}:8009/apps/FireTVRemote`, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'user-agent': 'okhttp/4.10.0' }, timeoutMs: 8000,
    }).catch(() => {});
    // O serviço leva uns segundos para abrir a 8080.
    for (let i = 0; i < 10; i++) {
      if (await this.reachable()) return true;
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  }

  async reachable() {
    try {
      const r = await request('POST', `https://${this.ip}:8080/v1/FireTV`, { headers: this.headers(false), timeoutMs: 1500 });
      return r.status > 0;
    } catch { return false; }
  }

  async call(method, path, body, { retry = true } = {}) {
    try {
      const r = await request(method, `https://${this.ip}:8080${path}`, { headers: this.headers(), body });
      if (r.status === 401 || r.status === 403) {
        const err = new Error('O Fire não reconhece mais este computador. Pareie de novo.');
        err.code = 'TOKEN';
        throw err;
      }
      // Fire TVs antigos respondem 500 mesmo executando o comando.
      if (r.status >= 200 && r.status < 300 || r.status === 500) { this.lastOk = Date.now(); return r.json ?? {}; }
      throw new Error(`O Fire respondeu ${r.status}`);
    } catch (e) {
      if (e.code === 'TOKEN' || !retry) throw e;
      await this.wake();
      return this.call(method, path, body, { retry: false });
    }
  }

  async showPin(friendlyName = 'Controle') {
    await this.wake();
    const r = await request('POST', `https://${this.ip}:8080/v1/FireTV/pin/display`, { headers: this.headers(false), body: { friendlyName } });
    if (r.status >= 300) throw new Error(`O Fire não mostrou o PIN (${r.status})`);
  }

  async verifyPin(pin) {
    const r = await request('POST', `https://${this.ip}:8080/v1/FireTV/pin/verify`, { headers: this.headers(false), body: { pin: String(pin) } });
    const token = r.json?.description;
    if (r.status >= 300 || !token) throw new Error('PIN não confere. Peça outro.');
    this.token = token;
    return token;
  }

  async key(name) {
    const map = LIGHTNING_KEYS[name];
    if (!map) {
      const err = new Error('Esse botão só funciona com a depuração ADB ligada');
      err.code = 'UNSUPPORTED';
      throw err;
    }
    const [kind, arg] = map;
    if (kind === 'nav') return this.call('POST', `/v1/FireTV?action=${arg}`, { keyActionType: 'keyDownUp' });
    if (kind === 'media') return this.call('POST', `/v1/media?action=${arg}`);
    if (kind === 'scan') return this.call('POST', '/v1/media?action=scan', { direction: arg, keyAction: { keyActionType: 'keyDownUp' } });
    if (kind === 'app') return this.launch(arg);
  }

  /** Só funciona com um campo de texto aberto na TV (o teclado do Fire na tela). */
  async text(text) {
    const kb = await this.call('GET', '/v1/FireTV/keyboard').catch(() => null);
    if (kb && kb.state === 'hidden') {
      const err = new Error('Abra antes um campo de texto na TV (a lupa de busca, por exemplo)');
      err.code = 'NO_KEYBOARD';
      throw err;
    }
    try {
      return await this.call('POST', '/v1/FireTV/text', { text });
    } catch {
      return this.call('POST', '/v1/FireTV/keyboard', { text });
    }
  }
  launch(pkg) { return this.call('POST', `/v1/FireTV/app/${encodeURIComponent(pkg)}`); }
  /** [{ appId, name, isInstalled }] */
  async apps() {
    const r = await this.call('GET', '/v1/FireTV/appsV2');
    return Array.isArray(r) ? r.filter((a) => a.appId && a.isInstalled !== false) : [];
  }
}
