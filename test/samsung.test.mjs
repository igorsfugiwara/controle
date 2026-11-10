// Uma "TV Samsung" falsa: ficha em /api/v2/ e o WebSocket do controle remoto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { SamsungTv } from '../src/samsung.mjs';

function fakeTv({ refuse = false } = {}) {
  const seen = [];
  let sock;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ device: { name: 'Samsung Q60', modelName: 'QN55Q60', wifiMac: 'AA:BB:CC:DD:EE:FF', TokenAuthSupport: 'false', PowerState: 'on' } }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    sock = ws;
    seen.push({ url: req.url });
    // A TV demora um pouco: é o tempo de alguém apertar "Permitir".
    setTimeout(() => ws.send(JSON.stringify(refuse
      ? { event: 'ms.channel.unauthorized' }
      : { event: 'ms.channel.connect', data: { token: '12345678' } })), 50);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      seen.push(msg);
      if (msg.params?.event === 'ed.installedApp.get') {
        ws.send(JSON.stringify({ event: 'ed.installedApp.get', data: { data: [
          { appId: '3201907018807', name: 'Netflix', app_type: 2 },
          { appId: '111299001912', name: 'YouTube', app_type: 2 },
          { appId: 'org.tizen.browser', name: 'Internet', app_type: 4 },
        ] } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, seen, send: (m) => sock.send(JSON.stringify(m)),
    close: () => { wss.close(); server.close(); },
  })));
}

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('demorou'); await new Promise((r) => setTimeout(r, 10)); }
};
const remoteKeys = (seen) => seen.filter((m) => m.params?.TypeOfRemote === 'SendRemoteKey').map((m) => `${m.params.Cmd}:${m.params.DataOfCmd}`);

test('conecta, guarda token e MAC, manda teclas, apps e texto', async () => {
  const tv = await fakeTv();
  const device = { id: 'samsung-x', kind: 'samsung', name: 'TV', ip: '127.0.0.1' };
  let saves = 0;
  const s = new SamsungTv(device, () => { saves++; }, { http: tv.port, ws: tv.port });
  s.start();
  await until(() => s.state === 'conectada');
  assert.equal(device.samsungToken, '12345678');
  assert.equal(device.mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(device.model, 'QN55Q60');
  assert.ok(saves >= 2);
  assert.match(tv.seen[0].url, /name=Q29udHJvbGU=/); // "Controle" em base64

  // Padrão: o voltar vai como apertar e soltar, igual ao controle físico.
  await s.run('key', { key: 'BACK' });
  await s.run('volumeUp');
  await s.run('key', { key: 'blue' });
  await s.run('setInput', { id: 'KEY_HDMI2' });
  await assert.rejects(s.run('key', { key: 'NAOEXISTE' }), /não existe/);
  await assert.rejects(s.run('setInput', { id: 'KEY_POWER' }), /inválida/);

  // Modo 2: o voltar vira clique, como nos outros apps.
  device.backMode = 'click';
  await s.run('key', { key: 'BACK' });
  await until(() => remoteKeys(tv.seen).length >= 6);
  assert.deepEqual(remoteKeys(tv.seen), [
    'Press:KEY_RETURN', 'Release:KEY_RETURN', 'Click:KEY_VOLUP', 'Click:KEY_CYAN', 'Click:KEY_HDMI2', 'Click:KEY_RETURN',
  ]);

  const apps = await s.run('apps');
  assert.deepEqual(apps.map((a) => a.title), ['Internet', 'Netflix', 'YouTube']);
  await s.run('launch', { id: '3201907018807' });
  await s.run('launch', { id: 'org.tizen.browser' });
  await until(() => tv.seen.filter((m) => m.params?.event === 'ed.apps.launch').length === 2);
  assert.deepEqual(tv.seen.filter((m) => m.params?.event === 'ed.apps.launch').map((m) => m.params.data.action_type), ['DEEP_LINK', 'NATIVE_LAUNCH']);

  // Texto só entra com o teclado da TV aberto.
  await assert.rejects(s.run('text', { text: 'oi' }), /campo de texto/);
  tv.send({ event: 'ms.remote.imeStart' });
  await until(() => s.ime);
  await s.run('text', { text: 'Stranger Things' });
  await until(() => tv.seen.some((m) => m.params?.TypeOfRemote === 'SendInputEnd'));
  const input = tv.seen.find((m) => m.params?.TypeOfRemote === 'SendInputString');
  assert.equal(Buffer.from(input.params.Cmd, 'base64').toString(), 'Stranger Things');

  s.stop();
  tv.close();
});

test('TV que recusa fica em "recusada"', async () => {
  const tv = await fakeTv({ refuse: true });
  const s = new SamsungTv({ id: 'samsung-y', kind: 'samsung', name: 'TV', ip: '127.0.0.1' }, () => {}, { http: tv.port, ws: tv.port });
  s.start();
  await until(() => s.state === 'recusada');
  await assert.rejects(s.run('key', { key: 'UP' }), /desconectada/);
  s.stop();
  tv.close();
});
