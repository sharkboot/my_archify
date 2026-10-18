// Real-mouse double-click test with screenshots.
// Uses CDP Input.dispatchMouseEvent (real hit-testing, real event sequence)
// instead of dispatchEvent, to prove the on-screen behavior the user sees.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe';
const ARTIFACT = path.resolve('toolsclaw-atlas.html');
const PORT = 9451;
const OUT_DIR = path.resolve('scripts');

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=1440,900',
  'file:///' + ARTIFACT.replace(/\\/g, '/'),
], { stdio: ['ignore', 'pipe', 'pipe'] });

const wait = ms => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(String(Math.random())).toString('base64'),
      },
    });
    req.on('response', res => reject(new Error('upgrade refused HTTP ' + res.statusCode)));
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => {
      let buf = Buffer.alloc(0);
      const inflight = [];
      const partial = new Map();
      const fail = msg => { while (inflight.length) inflight.shift().reject(new Error('cdp: ' + msg)); };
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0] & 0x80) !== 0;
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < off + 2) return; len = buf.readUInt16BE(off); off += 2; }
          else if (len === 127) { if (buf.length < off + 8) return; len = Number(buf.readBigUInt64BE(off)); off += 8; }
          let mk = null;
          if (masked) { if (buf.length < off + 4) return; mk = buf.subarray(off, off + 4); off += 4; }
          if (buf.length < off + len) return;
          let pl = buf.subarray(off, off + len);
          if (mk) { const un = Buffer.allocUnsafe(pl.length); for (let i = 0; i < pl.length; i++) un[i] = pl[i] ^ mk[i % 4]; pl = un; }
          buf = buf.subarray(off + len);
          if (opcode === 0x8) { fail('server close'); socket.end(); return; }
          if (opcode === 0x9) { socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); continue; }
          if (opcode === 0xa) continue;
          if (opcode === 0x1 || opcode === 0x0) {
            const first = opcode === 0x1;
            const entry = first ? { chunks: [pl] } : partial.get('current');
            if (first) { if (!inflight.length) { fail('data with no request'); return; } if (!fin) { partial.set('current', entry); continue; } }
            else { if (!entry) { fail('continuation no start'); return; } entry.chunks.push(pl); if (!fin) continue; partial.delete('current'); }
            const text = Buffer.concat(entry.chunks).toString('utf8');
            const r = inflight.shift();
            if (!r) { fail('unsolicited'); return; }
            try { r.resolve(JSON.parse(text)); } catch (e) { r.reject(new Error('bad json: ' + e.message)); }
          }
        }
      });
      socket.on('error', err => fail(err.message));
      socket.on('close', () => fail('socket closed'));
      let id = 0;
      const send = (method, params = {}) => new Promise((res, rej) => {
        const data = Buffer.from(JSON.stringify({ id: ++id, method, params: params || {} }), 'utf8');
        const mask = Buffer.from([Math.floor(Math.random()*256), Math.floor(Math.random()*256), Math.floor(Math.random()*256), Math.floor(Math.random()*256)]);
        const masked = Buffer.allocUnsafe(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
        let header;
        if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
        else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
        inflight.push({ method, resolve: msg => msg.error ? rej(new Error(method + ': ' + msg.error.message)) : res(msg.result), reject: rej });
        socket.write(Buffer.concat([header, mask, masked]));
      });
      resolve({ send, socket });
    });
    req.end();
  });
}

async function main() {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await wait(250);
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {}
  }
  if (!target) throw new Error('no page');

  const { send } = await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');
  await wait(2000);

  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + ((r.exceptionDetails.exception || {}).description || ''));
    return r.result.value;
  };

  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('saved', file);
  };

  // Wait for runtime
  for (let i = 0; i < 40; i++) {
    if (await ev('!!(window.Archify && Archify.drilldown)').catch(() => false)) break;
    await wait(250);
  }

  // Get runner node viewport center
  const pos = await ev([
    '(function(){',
    '  var n = document.querySelector("[data-node-id=runner]");',
    '  if (!n) return JSON.stringify({found:false});',
    '  var r = n.getBoundingClientRect();',
    '  return JSON.stringify({found:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});',
    '})()'
  ].join('\n'));
  const p = JSON.parse(pos);
  console.log('runner center:', JSON.stringify(p));
  if (!p.found) { console.log('RUNNER NOT FOUND - cannot test'); chrome.kill(); return; }

  await shot('drilldown-before');

  console.log('depth before:', await ev('Archify.drilldown.depth()'));

  // REAL double-click via CDP Input
  const clickPair = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  // First click
  await clickPair(p.x, p.y);
  await wait(120);
  // Second click (clickCount 2 -> browser synthesizes dblclick)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 2 });
  await wait(500);

  const after = await ev([
    'JSON.stringify({',
    '  depth: Archify.drilldown.depth(),',
    '  active: Archify.drilldown.active(),',
    '  barHidden: document.getElementById("drilldown-bar").hidden,',
    '  crumbs: document.querySelectorAll(".drilldown-crumb").length,',
    '  nodeCount: document.querySelectorAll("[data-node-id]").length,',
    '  svgViewBox: (document.querySelector(".diagram-container > svg")||{}).getAttribute && document.querySelector(".diagram-container > svg").getAttribute("viewBox"),',
    '  panelHidden: document.getElementById("drilldown-detail").hidden,',
    '  panelTitle: (document.getElementById("drilldown-detail-title")||{textContent:""}).textContent,',
    '})'
  ].join('\n'));
  console.log('after real double-click:', after);

  await shot('drilldown-after-dblclick');

  // Now go back to root and try double-click on a code leaf (cli) - should refuse
  await ev('Archify.drilldown.reset()');
  await wait(300);
  const cliPos = await ev([
    '(function(){',
    '  var n = document.querySelector("[data-node-id=cli]");',
    '  if (!n) return JSON.stringify({found:false});',
    '  var r = n.getBoundingClientRect();',
    '  return JSON.stringify({found:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});',
    '})()'
  ].join('\n'));
  const cp = JSON.parse(cliPos);
  if (cp.found) {
    const depthBefore = await ev('Archify.drilldown.depth()');
    await clickPair(cp.x, cp.y);
    await wait(120);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cp.x, y: cp.y, button: 'left', clickCount: 2 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cp.x, y: cp.y, button: 'left', clickCount: 2 });
    await wait(400);
    console.log('code-leaf dblclick: depthBefore=' + depthBefore + ' depthAfter=' + await ev('Archify.drilldown.depth()') + ' (should be equal, code leaf has no sub-level)');
  }

  chrome.kill();
  console.log('DONE');
}

main().catch(err => {
  console.error('FAIL:', err.message);
  try { chrome.kill(); } catch {}
  process.exit(1);
});
