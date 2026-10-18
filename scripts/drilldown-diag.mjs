// Comprehensive drilldown diagnostic for toolsclaw-atlas.html
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const CHROME = process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe';
const ARTIFACT = path.resolve('toolsclaw-atlas.html');
const PORT = 9445;

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
    const key = Buffer.from(Math.random().toString(36)).toString('base64');
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
      },
    });
    req.on('upgrade', (_res, socket) => {
      let buf = Buffer.alloc(0);
      const pending = [];
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const len0 = buf[1] & 0x7f;
          let offset = 2, len = len0;
          if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
          else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
          if (buf.length < offset + len) return;
          const payload = buf.subarray(offset, offset + len).toString('utf8');
          buf = buf.subarray(offset + len);
          try { pending.shift()?.(JSON.parse(payload)); } catch {}
        }
      });
      let id = 0;
      const send = (method, params = {}) => new Promise(res => {
        pending.push(res);
        const data = Buffer.from(JSON.stringify({id: ++id, method, params}), 'utf8');
        const mask = Buffer.from([Math.floor(Math.random()*256), Math.floor(Math.random()*256), Math.floor(Math.random()*256), Math.floor(Math.random()*256)]);
        const masked = Buffer.allocUnsafe(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
        let header;
        if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
        else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
        socket.write(Buffer.concat([header, mask, masked]));
      });
      resolve({send, socket});
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await wait(250);
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {}
  }
  if (!target) { console.log('ERROR: No debuggable page found'); chrome.kill(); return; }

  const {send} = await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await wait(2000);

  const ev = async expr => {
    const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  console.log('=== DRILLDOWN DIAGNOSTIC ===\n');

  // 1. Module presence
  console.log('1. MODULE PRESENCE');
  const mod = await ev([
    'JSON.stringify({',
    '  hasArchify: !!(window.Archify),',
    '  hasDrilldown: !!(window.Archify && Archify.drilldown),',
    '  depthFn: typeof (Archify && Archify.drilldown && Archify.drilldown.depth),',
    '  descendFn: typeof (Archify && Archify.drilldown && Archify.drilldown.descend),',
    '  resetFn: typeof (Archify && Archify.drilldown && Archify.drilldown.reset),',
    '  activeFn: typeof (Archify && Archify.drilldown && Archify.drilldown.active),',
    '})'
  ].join('\n'));
  console.log('   ', mod);

  // 2. Data payload
  console.log('\n2. PAYLOAD DATA');
  const payload = await ev([
    'JSON.stringify({',
    '  scriptExists: !!document.getElementById("archify-detail-data"),',
    '  nodesCount: Object.keys((JSON.parse(document.getElementById("archify-detail-data").textContent)||{}).nodes||{}).length,',
    '  drillableCount: document.querySelectorAll("[data-node-drilldown]").length,',
    '})'
  ].join('\n'));
  console.log('   ', payload);

  // 3. Visual elements
  console.log('\n3. VISUAL ELEMENTS');
  const visual = await ev([
    'JSON.stringify({',
    '  badges: document.querySelectorAll("[data-drilldown-badge]").length,',
    '  barExists: !!document.getElementById("drilldown-bar"),',
    '  panelExists: !!document.getElementById("drilldown-detail"),',
    '  barHidden: document.getElementById("drilldown-bar").hidden,',
    '  panelHidden: document.getElementById("drilldown-detail").hidden,',
    '})'
  ].join('\n'));
  console.log('   ', visual);

  // 4. Runner node state
  console.log('\n4. RUNNER NODE STATE');
  const runner = await ev([
    'JSON.stringify({',
    '  exists: !!document.querySelector("[data-node-id=runner]"),',
    '  hasDrilldownAttr: !!(document.querySelector("[data-node-id=runner]")?.getAttribute("data-node-drilldown")),',
    '  hasBadge: !!(document.querySelector("[data-node-id=runner]")?.querySelector("[data-drilldown-badge]")),',
    '  cursor: document.querySelector("[data-node-id=runner]") ? getComputedStyle(document.querySelector("[data-node-id=runner]")).cursor : "N/A",',
    '})'
  ].join('\n'));
  console.log('   ', runner);

  // 5. Event handlers (check by dispatching events)
  console.log('\n5. INTERACTION TEST');
  const interaction = await ev([
    '(function(){',
    '  var results = {};',
    '  var runner = document.querySelector("[data-node-id=runner]");',
    '  if (!runner) return JSON.stringify({error: "runner not found"});',
    '  ',
    '  // Test single click',
    '  runner.dispatchEvent(new MouseEvent("click", {bubbles: true}));',
    '  results.clickDepth = Archify.drilldown.depth();',
    '  results.clickPanelShown = !document.getElementById("drilldown-detail").hidden;',
    '  results.clickTitle = document.getElementById("drilldown-detail-title")?.textContent || "N/A";',
    '  ',
    '  // Reset and test double click',
    '  Archify.drilldown.reset();',
    '  runner.dispatchEvent(new MouseEvent("dblclick", {bubbles: true}));',
    '  results.dblclickDepth = Archify.drilldown.depth();',
    '  results.dblclickActive = Archify.drilldown.active();',
    '  results.dblclickBarHidden = document.getElementById("drilldown-bar").hidden;',
    '  results.dblclickCrumbs = document.querySelectorAll(".drilldown-crumb").length;',
    '  results.dblclickNodeCount = document.querySelectorAll("[data-node-id]").length;',
    '  results.dblclickTitle = document.getElementById("drilldown-detail-title")?.textContent || "N/A";',
    '  ',
    '  return JSON.stringify(results);',
    '})()'
  ].join('\n'));
  console.log('   ', interaction);

  // 6. Badge visibility
  console.log('\n6. BADGE VISIBILITY');
  const badgeVis = await ev([
    '(function(){',
    '  var badges = document.querySelectorAll("[data-drilldown-badge]");',
    '  if (!badges.length) return JSON.stringify({count: 0, visible: false});',
    '  var first = badges[0];',
    '  var style = getComputedStyle(first);',
    '  var rect = first.querySelector(".drilldown-badge-shape");',
    '  return JSON.stringify({',
    '    count: badges.length,',
    '    firstVisible: style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) > 0,',
    '    rectExists: !!rect,',
    '    rectFill: rect ? getComputedStyle(rect).fill : "N/A",',
    '  });',
    '})()'
  ].join('\n'));
  console.log('   ', badgeVis);

  console.log('\n=== END DIAGNOSTIC ===');
  chrome.kill();
}

run().catch(err => {
  console.error('DIAGNOSTIC ERROR:', err.message);
  chrome.kill();
  process.exit(1);
});
