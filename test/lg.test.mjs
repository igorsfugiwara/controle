// Uma "TV LG" falsa, para conferir pareamento, comandos e o canal de teclas sem a TV ligada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { LgTv } from '../src/lg.mjs';

test('pareia, guarda a chave, manda volume e tecla', async () => {
  const seen = [];
  const pointer = new WebSocketServer({ port: 0 });
  const pointerMsgs = [];
  pointer.on('connection', (ws) => ws.on('message', (m) => pointerMsgs.push(m.toString())));
  const tv = new WebSocketServer({ port: 0 });
  tv.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      seen.push(msg);
      if (msg.type === 'register') {
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { pairingType: 'PROMPT', returnValue: true } }));
        setTimeout(() => ws.send(JSON.stringify({ type: 'registered', id: msg.id, payload: { 'client-key': 'chave123' } })), 30);
      } else if (msg.type === 'subscribe') {
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { volume: 12, muted: false, returnValue: true } }));
      } else if (msg.uri === 'ssap://com.webos.service.networkinput/getPointerInputSocket') {
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true, socketPath: `ws://127.0.0.1:${pointer.address().port}/p` } }));
      } else if (msg.uri === 'ssap://tv/getExternalInputList') {
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true, devices: [{ id: 'HDMI_1', label: 'Fire', connected: true }] } }));
      } else {
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true } }));
      }
    });
  });
  await new Promise((r) => tv.on('listening', r));

  const device = { id: 'lg-x', kind: 'lg', name: 'TV', ip: '127.0.0.1' };
  let savedKey = null;
  const lg = new LgTv(device, (k) => { savedKey = k; });
  // A falsa só escuta em ws (sem TLS) numa porta qualquer.
  lg.connect = async function () {
    this.setState('conectando');
    await this.tryUrl(`ws://127.0.0.1:${tv.address().port}`);
  };
  const states = [];
  lg.on('status', () => states.push(lg.state));
  lg.start();
  await new Promise((r) => { const t = setInterval(() => { if (lg.state === 'conectada') { clearInterval(t); r(); } }, 10); });

  assert.deepEqual(states.slice(0, 3), ['conectando', 'aguardando-permissao', 'conectada']);
  assert.equal(savedKey, 'chave123');
  assert.equal(device.clientKey, 'chave123');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(lg.volume, { level: 12, muted: false });

  await lg.run('volumeUp');
  assert.equal(seen.at(-1).uri, 'ssap://audio/volumeUp');
  await lg.run('mute');
  assert.deepEqual(seen.at(-1).payload, { mute: true });
  const inputs = await lg.run('inputs');
  assert.deepEqual(inputs, [{ id: 'HDMI_1', label: 'Fire', connected: true, icon: undefined }]);
  await lg.run('setInput', { id: 'HDMI_1' });
  assert.deepEqual(seen.at(-1), { type: 'request', id: seen.at(-1).id, uri: 'ssap://tv/switchInput', payload: { inputId: 'HDMI_1' } });

  await lg.run('key', { key: 'up' });
  await lg.run('key', { key: 'ENTER' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pointerMsgs, ['type:button\nname:UP\n\n', 'type:button\nname:ENTER\n\n']);
  await assert.rejects(lg.run('key', { key: 'rm -rf' }), /desconhecida/);

  lg.stop();
  tv.close();
  pointer.close();
});
