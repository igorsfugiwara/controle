// Controle no celular: fala com a ponte do PC por WebSocket.
const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- conexão com a ponte ----------
let ws = null;
let seq = 0;
const waiting = new Map();
let devices = [];
let selectedId = store.get('controle.aparelho');

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { $('#conn').hidden = true; };
  ws.onclose = () => {
    $('#conn').hidden = false;
    for (const w of waiting.values()) w.reject(new Error('Sem conexão com o computador'));
    waiting.clear();
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'devices') { devices = msg.devices; render(); }
    if (msg.type === 'reply') {
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      msg.ok ? w.resolve(msg.data) : w.reject(new Error(msg.error));
    }
  };
}

function call(payload, { quiet = false } = {}) {
  if (!ws || ws.readyState !== 1) {
    if (!quiet) toast('Sem conexão com o computador');
    return Promise.reject(new Error('offline'));
  }
  const id = ++seq;
  ws.send(JSON.stringify({ id, ...payload }));
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('Sem resposta')); }, 12000);
  }).catch((e) => { if (!quiet && e.message !== 'offline') toast(e.message); throw e; });
}

const run = (device, action, args) => call({ device, action, args }).catch(() => {});

// ---------- utilidades ----------
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 2600);
}
const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} };

const selected = () => devices.find((d) => d.id === selectedId) ?? devices[0];
const lgDevice = () => devices.find((d) => d.kind === 'lg');

const STATE_TEXT = {
  conectada: 'Conectado',
  conectando: 'Conectando…',
  'aguardando-permissao': 'Aceite o aviso na TV',
  'sem-adb': 'Depuração ADB desligada',
  desconectada: 'Desconectado',
};

// ---------- desenho ----------
let renderedKey = '';
const devicesListeners = new Set();

function render() {
  renderMain();
  for (const f of devicesListeners) f();
}

function renderMain() {
  const cur = selected();
  if (cur) selectedId = cur.id;

  const tabs = $('#tabs');
  tabs.replaceChildren(...devices.map((d) => h('button', {
    class: 'tab', role: 'tab', 'aria-selected': String(d.id === selectedId),
    onclick: () => { selectedId = d.id; store.set('controle.aparelho', d.id); buzz(); render(); },
  }, h('span', { class: `dot dot--${d.state}` }), d.name)));

  const stage = $('#stage');
  if (!cur) {
    renderedKey = '';
    stage.replaceChildren(h('div', { class: 'notice' },
      h('b', {}, 'Nenhum aparelho ainda. '),
      'Ligue a TV e o Fire Stick e toque em procurar.',
      h('div', { class: 'notice__actions' },
        h('button', { class: 'btn btn--primary btn--sm', onclick: () => openSettings(true) }, 'Procurar aparelhos'))));
    return;
  }

  // Só redesenha o controle quando muda de aparelho; status atualiza no lugar.
  const key = `${cur.id}`;
  if (renderedKey !== key) {
    renderedKey = key;
    const tpl = $(cur.kind === 'lg' ? '#tpl-lg' : '#tpl-fire').content.cloneNode(true);
    stage.replaceChildren(h('div', { id: 'notice-slot' }), tpl);
    bindRemote($('.remote', stage), cur);
    appsLoadedFor = null;
  }
  updateStatus(cur);
}

function updateStatus(cur) {
  const slot = $('#notice-slot');
  const remote = $('.remote');
  if (!slot || !remote) return;
  slot.replaceChildren(...(noticeFor(cur) ?? []));
  remote.classList.toggle('remote--offline', cur.state !== 'conectada' && !(cur.kind === 'lg' && cur.state === 'desconectada'));

  const vol = $('[data-vol]', remote);
  if (vol) vol.textContent = cur.volume ? (cur.volume.muted ? 'mudo' : cur.volume.level) : '';

  const lg = lgDevice();
  const note = $('[data-vol-note]', remote);
  if (note) note.textContent = lg?.state === 'conectada' ? `Volume e mudo vão para a ${lg.name}` : '';
  for (const el of remote.querySelectorAll('[data-needs="lg"]')) el.hidden = !lg;

  if (cur.kind === 'fire' && cur.state === 'conectada' && appsLoadedFor !== cur.id) loadFireApps(cur);
}

function noticeFor(d) {
  const retry = h('button', { class: 'btn btn--sm', onclick: () => call({ op: 'reconnect', device: d.id }).catch(() => {}) }, 'Tentar de novo');
  if (d.state === 'conectada' || d.state === 'conectando') return null;
  if (d.kind === 'lg') {
    if (d.state === 'aguardando-permissao') {
      return [h('div', { class: 'notice' }, h('b', {}, 'Olhe a TV: '), 'apareceu um aviso pedindo permissão. Aceite com o controle da TV (ou no botão dela). É só na primeira vez.')];
    }
    return [h('div', { class: 'notice' },
      h('b', {}, 'TV desligada ou fora do Wi-Fi. '), 'O botão vermelho tenta ligar pela rede.',
      h('div', { class: 'notice__actions' }, retry))];
  }
  if (d.state === 'aguardando-permissao') {
    return [h('div', { class: 'notice' }, h('b', {}, 'Olhe a TV: '), 'o Fire pergunta se permite a depuração. Marque ', h('b', {}, '“Sempre permitir deste computador”'), ' e toque em OK.')];
  }
  if (d.state === 'sem-adb') {
    return [h('div', { class: 'notice notice--bad' },
      h('b', {}, 'Falta ligar a depuração ADB no Fire (uma vez só):'),
      h('ol', {},
        h('li', {}, 'Configurações → Minha Fire TV → Sobre.'),
        h('li', {}, 'Clique 7 vezes no nome do aparelho (ex.: “Fire TV Stick”) até aparecer “Você é um desenvolvedor”.'),
        h('li', {}, 'Volte → Opções do desenvolvedor → Depuração ADB → Ativado.')),
      h('div', { class: 'notice__actions' }, retry))];
  }
  return [h('div', { class: 'notice notice--bad' }, h('b', {}, 'Fire Stick fora da rede. '), d.ip, h('div', { class: 'notice__actions' }, retry))];
}

// ---------- botões ----------
function bindRemote(root, dev) {
  const send = (btn, long = false) => {
    const d = devices.find((x) => x.id === dev.id) ?? dev;
    if (btn.dataset.key) {
      run(d.id, 'key', { key: btn.dataset.key, long });
    } else if (btn.dataset.action) {
      run(d.id, btn.dataset.action);
    }
  };

  for (const btn of root.querySelectorAll('[data-key], [data-action]')) {
    let repeatTimer = null;
    let longTimer = null;
    let longFired = false;
    const stop = () => {
      clearTimeout(repeatTimer); clearInterval(repeatTimer); clearTimeout(longTimer);
      repeatTimer = longTimer = null;
      btn.classList.remove('is-down');
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      btn.classList.add('is-down');
      buzz();
      if (btn.dataset.longKey) {
        longFired = false;
        longTimer = setTimeout(() => { longFired = true; buzz(30); send(btn, true); }, 550);
        return;
      }
      send(btn);
      if (btn.hasAttribute('data-repeat')) {
        const every = dev.kind === 'fire' ? 160 : 120;
        repeatTimer = setTimeout(() => { repeatTimer = setInterval(() => send(btn), every); }, 420);
      }
    });
    btn.addEventListener('pointerup', () => {
      if (btn.dataset.longKey && longTimer && !longFired) send(btn);
      stop();
    });
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  for (const btn of root.querySelectorAll('[data-sheet]')) {
    btn.addEventListener('click', () => { buzz(); openSheet(btn.dataset.sheet, dev); });
  }
}

let appsLoadedFor = null;
async function loadFireApps(dev) {
  appsLoadedFor = dev.id;
  const box = $('[data-apps]');
  if (!box) return;
  try {
    const apps = await call({ device: dev.id, action: 'apps' }, { quiet: true });
    box.replaceChildren(...apps.slice(0, 6).map((a) => h('button', {
      class: `app${/#fff|#ff[ef]/i.test(a.color) ? ' app--light' : ''}`, style: { '--app': a.color },
      onclick: () => { buzz(); run(dev.id, 'launch', { id: a.id }); },
    }, a.title)));
  } catch { appsLoadedFor = null; }
}

// ---------- folhas ----------
const sheet = $('#sheet');
const backdrop = $('#sheet-backdrop');
let sheetCleanup = null;

function showSheet(title, body) {
  sheetCleanup?.();
  sheetCleanup = null;
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(body);
  sheet.hidden = false;
  backdrop.hidden = false;
}
function closeSheet() {
  sheetCleanup?.();
  sheetCleanup = null;
  sheet.hidden = true;
  backdrop.hidden = true;
}
backdrop.addEventListener('click', closeSheet);
for (const b of document.querySelectorAll('[data-close-sheet]')) b.addEventListener('click', closeSheet);

function openSheet(kind, dev) {
  if (kind === 'inputs') return openInputs();
  if (kind === 'apps') return openLgApps(dev);
  if (kind === 'numbers') return openNumbers(dev);
  if (kind === 'keyboard') return openKeyboard(dev);
  if (kind === 'touchpad') return openTouchpad(dev);
}

async function openInputs() {
  const tv = lgDevice();
  if (!tv) return toast('Nenhuma TV LG cadastrada');
  const list = h('div', { class: 'list' }, h('p', { class: 'empty' }, 'Perguntando à TV…'));
  showSheet('Entradas da TV', list);
  try {
    const inputs = await call({ device: tv.id, action: 'inputs' });
    list.replaceChildren(...inputs.map((i) => h('button', {
      class: `list__item${i.connected ? '' : ' list__item--off'}`,
      onclick: () => { buzz(); run(tv.id, 'setInput', { id: i.id }); closeSheet(); toast(`TV em ${i.label}`); },
    }, h('span', {}, i.label), h('small', {}, i.connected ? 'conectado' : 'vazio'))),
    h('button', { class: 'list__item', onclick: () => { buzz(); run(tv.id, 'launch', { id: 'com.webos.app.livetv' }); closeSheet(); } },
      h('span', {}, 'TV ao vivo (antena)'), h('small', {}, '')));
    if (!inputs.length) list.prepend(h('p', { class: 'empty' }, 'A TV não listou entradas.'));
  } catch (e) {
    list.replaceChildren(h('p', { class: 'empty' }, `Não deu: ${e.message}`));
  }
}

async function openLgApps(dev) {
  const grid = h('div', { class: 'grid-apps' }, h('p', { class: 'empty' }, 'Carregando apps…'));
  showSheet('Apps da TV', grid);
  try {
    const apps = await call({ device: dev.id, action: 'apps' });
    grid.replaceChildren(...apps.map((a) => h('button', {
      class: 'list__item', onclick: () => { buzz(); run(dev.id, 'launch', { id: a.id }); closeSheet(); },
    }, a.title)));
  } catch (e) {
    grid.replaceChildren(h('p', { class: 'empty' }, `Não deu: ${e.message}`));
  }
}

function openNumbers(dev) {
  const key = (k, label = k) => h('button', { class: 'key', onclick: () => { buzz(); run(dev.id, 'key', { key: k }); } }, label);
  showSheet('Números', h('div', { class: 'numpad' },
    ...'123456789'.split('').map((n) => key(n)), key('DASH', '–'), key('0'), key('LIST', 'Lista')));
}

function openKeyboard(dev) {
  const input = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send', placeholder: 'Digite aqui; vai direto para a TV' });
  let last = '';
  input.addEventListener('input', () => {
    const v = input.value;
    let common = 0;
    while (common < v.length && common < last.length && v[common] === last[common]) common++;
    const removed = last.length - common;
    const added = v.slice(common);
    if (removed > 0) run(dev.id, 'backspace', { count: removed });
    if (added) run(dev.id, 'text', { text: added });
    last = v;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(dev.id, 'enter'); input.value = ''; last = ''; }
  });
  showSheet('Teclado', h('div', { class: 'kbd' },
    input,
    h('div', { class: 'kbd__row' },
      h('button', { class: 'btn', onclick: () => { run(dev.id, 'backspace', { count: 1 }); input.value = input.value.slice(0, -1); last = input.value; } }, 'Apagar'),
      h('button', { class: 'btn', onclick: () => { input.value = ''; last = ''; input.focus(); } }, 'Limpar campo'),
      h('button', { class: 'btn btn--primary', onclick: () => { run(dev.id, 'enter'); input.value = ''; last = ''; } }, 'Enter')),
    h('p', { class: 'hint' }, 'Abra antes o campo de busca ou de senha na TV. Cada letra vai na hora.')));
  setTimeout(() => input.focus(), 50);
}

function openTouchpad(dev) {
  const pad = h('div', { class: 'touchpad' }, 'Arraste para mover o cursor. Toque para clicar.');
  const scroll = h('div', { class: 'touchpad', style: { height: '56px', marginTop: '10px' } }, 'Arraste aqui para rolar');
  let last = null, start = null, moved = 0, pending = { dx: 0, dy: 0 }, timer = null;
  const flush = () => {
    timer = null;
    if (pending.dx || pending.dy) { run(dev.id, 'move', pending); pending = { dx: 0, dy: 0 }; }
  };
  pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); last = start = { x: e.clientX, y: e.clientY, t: Date.now() }; moved = 0; pad.classList.add('is-active'); });
  pad.addEventListener('pointermove', (e) => {
    if (!last) return;
    const dx = (e.clientX - last.x) * 1.6, dy = (e.clientY - last.y) * 1.6;
    moved += Math.abs(dx) + Math.abs(dy);
    last = { x: e.clientX, y: e.clientY };
    pending.dx += dx; pending.dy += dy;
    if (!timer) timer = setTimeout(flush, 33);
  });
  pad.addEventListener('pointerup', () => {
    pad.classList.remove('is-active');
    if (start && moved < 10 && Date.now() - start.t < 300) { buzz(); run(dev.id, 'click'); }
    last = start = null;
  });
  let sLast = null;
  scroll.addEventListener('pointerdown', (e) => { scroll.setPointerCapture(e.pointerId); sLast = e.clientX; });
  scroll.addEventListener('pointermove', (e) => {
    if (sLast == null) return;
    const d = e.clientX - sLast;
    if (Math.abs(d) > 12) { run(dev.id, 'scroll', { dy: d > 0 ? 1 : -1 }); sLast = e.clientX; }
  });
  scroll.addEventListener('pointerup', () => { sLast = null; });
  showSheet('Touchpad', h('div', {}, pad, scroll,
    h('div', { class: 'kbd__row', style: { marginTop: '10px' } },
      h('button', { class: 'btn', onclick: () => run(dev.id, 'key', { key: 'BACK' }) }, 'Voltar'),
      h('button', { class: 'btn', onclick: () => run(dev.id, 'key', { key: 'HOME' }) }, 'Início'))));
}

// ---------- aparelhos e ajustes ----------
$('#open-settings').addEventListener('click', () => openSettings(false));

function openSettings(autoSearch) {
  const list = h('div', { class: 'list' });
  const result = h('div', {});
  const drawList = () => list.replaceChildren(...(devices.length ? devices.map(deviceCard) : [h('p', { class: 'empty' }, 'Nenhum aparelho cadastrado.')]));
  const search = async () => {
    result.replaceChildren(h('p', { class: 'empty' }, 'Procurando por 3 segundos…'));
    try {
      const found = await call({ op: 'discover' });
      const tv = found.filter((f) => f.kind !== 'outro');
      result.replaceChildren(h('p', { class: 'empty' }, tv.length
        ? `Achei: ${tv.map((f) => `${f.name} (${f.ip})`).join(', ')}. Os que funcionam já entraram na lista.`
        : 'Não achei nada. A TV está ligada e no mesmo Wi-Fi?'));
    } catch { result.replaceChildren(); }
  };
  const searchBtn = h('button', { class: 'btn btn--primary', onclick: search });
  searchBtn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg>Procurar aparelhos';
  showSheet('Aparelhos', h('div', {},
    list,
    h('p', { class: 'section-title' }, 'Achar na rede'),
    searchBtn, result,
    h('p', { class: 'section-title' }, 'Adicionar pelo IP'),
    addForm(),
    help()));
  drawList();
  devicesListeners.add(drawList);
  sheetCleanup = () => devicesListeners.delete(drawList);
  if (autoSearch) search();
}

function deviceCard(d) {
  return h('div', { class: 'dev' },
    h('div', { class: 'dev__top' }, h('span', { class: `dot dot--${d.state}` }), h('span', { class: 'dev__name' }, d.name)),
    h('div', { class: 'dev__meta' }, `${d.kind === 'lg' ? 'TV LG' : 'Fire Stick'} · ${d.ip}${d.model ? ` · ${d.model}` : ''} · ${STATE_TEXT[d.state] ?? d.state}`),
    h('div', { class: 'dev__actions' },
      h('button', { class: 'btn btn--sm', onclick: () => call({ op: 'reconnect', device: d.id }).catch(() => {}) }, 'Reconectar'),
      h('button', { class: 'btn btn--sm', onclick: () => {
        const name = prompt('Nome do aparelho', d.name);
        if (name) call({ op: 'rename', device: d.id, name }).catch(() => {});
      } }, 'Renomear'),
      h('button', { class: 'btn btn--sm btn--danger', onclick: () => {
        if (confirm(`Tirar “${d.name}” da lista? Dá para achar de novo depois.`)) call({ op: 'remove', device: d.id }).catch(() => {});
      } }, 'Tirar')));
}

function addForm() {
  const kind = h('select', { 'aria-label': 'Tipo' }, h('option', { value: 'lg' }, 'TV LG'), h('option', { value: 'fire' }, 'Fire Stick'));
  const ip = h('input', { inputmode: 'decimal', placeholder: '192.168.15.20', 'aria-label': 'IP' });
  return h('div', { class: 'add' }, kind, ip, h('button', { class: 'btn btn--sm', style: { height: '44px' }, onclick: () => {
    call({ op: 'add', kind: kind.value, ip: ip.value }).then(() => { toast('Adicionado'); ip.value = ''; }).catch(() => {});
  } }, 'Adicionar'));
}

function help() {
  return h('div', {},
    h('details', { class: 'help' }, h('summary', {}, 'Ligar a TV LG pelo celular'),
      h('ol', {},
        h('li', {}, 'Na TV: Configurações → Geral → Dispositivos (ou Conexão) → ative “Ligar via Wi-Fi” / “LG Connect Apps”.'),
        h('li', {}, 'Se tiver “Quick Start+”, ative também.'),
        h('li', {}, 'Ligue a TV uma vez com ela conectada aqui, para o computador aprender o endereço dela.'))),
    h('details', { class: 'help' }, h('summary', {}, 'Ativar o Fire Stick (depuração ADB)'),
      h('ol', {},
        h('li', {}, 'Configurações → Minha Fire TV → Sobre.'),
        h('li', {}, 'Clique 7 vezes no nome do aparelho até aparecer “Você é um desenvolvedor”.'),
        h('li', {}, 'Volte → Opções do desenvolvedor → Depuração ADB → Ativado.'),
        h('li', {}, 'Quando a TV perguntar, marque “Sempre permitir deste computador”.'))),
    h('details', { class: 'help' }, h('summary', {}, 'Pôr na tela inicial do celular'),
      h('ol', {},
        h('li', {}, 'No Chrome, menu ⋮ → “Adicionar à tela inicial”.'),
        h('li', {}, 'Para o link não mudar, reserve no roteador um IP fixo para este computador, a TV e o Fire.'))));
}

connect();
