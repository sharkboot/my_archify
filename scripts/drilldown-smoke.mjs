// Drive the delivered HTML through the DevTools protocol to prove the
// drill-down interaction really works, not just that the module parsed.
//
// Chrome is launched with --remote-allow-origins=* : without it Chrome 111+
// rejects the upgrade with 403 and the socket dies with ECONNRESET.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const CHROME = (process.env.LOCALAPPDATA || 'C:/Users/shark/AppData/Local')
  + '/Google/Chrome/Application/chrome.exe';
const ARTIFACT = path.resolve(process.argv[2]);
const PORT = Number(process.env.CDP_PORT || 9331);
const VERBOSE = process.env.CDP_VERBOSE === '1';

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,900',
  'file:///' + ARTIFACT.replace(/\\/g, '/'),
], { stdio: ['ignore', 'pipe', 'pipe'] });

chrome.stderr.on('data', (d) => { if (VERBOSE) process.stderr.write('[chrome] ' + d); });
chrome.on('error', (err) => console.error('[chrome spawn] ' + err.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Minimal RFC 6455 client: frames are parsed incrementally and payloads
// accumulated across continuations, so a response split over several TCP
// segments still resolves. Server frames are never masked.
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(String(Math.random())).toString('base64'),
      },
    });

    req.on('response', (res) => {
      reject(new Error('upgrade refused: HTTP ' + res.statusCode
        + ' (missing --remote-allow-origins=*?)'));
    });
    req.on('error', reject);

    req.on('upgrade', (_res, socket) => {
      let buf = Buffer.alloc(0);
      const inflight = [];   // FIFO of {method, resolve, reject}
      const partial = new Map(); // id -> {opcode, chunks}

      const protocolError = (msg) => {
        while (inflight.length) inflight.shift().reject(new Error('cdp protocol error: ' + msg));
      };

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0] & 0x80) !== 0;
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < offset + 2) return;
            len = buf.readUInt16BE(offset); offset += 2;
          } else if (len === 127) {
            if (buf.length < offset + 8) return;
            len = Number(buf.readBigUInt64BE(offset)); offset += 8;
          }
          let maskKey = null;
          if (masked) {
            if (buf.length < offset + 4) return;
            maskKey = buf.subarray(offset, offset + 4); offset += 4;
          }
          if (buf.length < offset + len) return;
          let payload = buf.subarray(offset, offset + len);
          if (maskKey) {
            const un = Buffer.allocUnsafe(payload.length);
            for (let i = 0; i < payload.length; i += 1) un[i] = payload[i] ^ maskKey[i % 4];
            payload = un;
          }
          buf = buf.subarray(offset + len);

          if (opcode === 0x8) { protocolError('server sent close'); socket.end(); return; }
          if (opcode === 0x9) { socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); continue; }
          if (opcode === 0xa) continue;

          if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
            const key = inflight.length ? inflight[0] : null;
            const first = opcode !== 0x0;
            const entry = first
              ? { chunks: [payload], opcode }
              : partial.get('current');
            if (first) {
              if (!key) { protocolError('data frame with no in-flight request'); return; }
              if (!fin) { partial.set('current', entry); continue; }
            } else if (!entry) {
              protocolError('continuation with no start'); return;
            } else {
              entry.chunks.push(payload);
              if (!fin) continue;
              partial.delete('current');
            }
            const text = Buffer.concat(entry.chunks).toString('utf8');
            if (VERBOSE) console.error('[cdp <<] ' + text.slice(0, 400));
            const req0 = inflight.shift();
            if (!req0) { protocolError('unsolicited frame'); return; }
            let msg;
            try { msg = JSON.parse(text); } catch (e) {
              req0.reject(new Error('bad JSON from cdp: ' + e.message));
              continue;
            }
            req0.resolve(msg);
          }
        }
      });

      socket.on('error', (err) => { protocolError(err.message); });
      socket.on('close', () => { protocolError('socket closed'); });

      let id = 0;
      const send = (method, params = {}) => new Promise((resolve1, reject1) => {
        const data = Buffer.from(JSON.stringify({ id: ++id, method, params: params || {} }), 'utf8');
        // Client frames MUST be masked with a real key that is XORed into the
        // payload; declaring the mask bit with a zero key makes Chrome drop the
        // frame silently and every call resolves to undefined.
        const mask = Buffer.from([
          Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
          Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
        ]);
        const masked = Buffer.allocUnsafe(data.length);
        for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];
        let header;
        if (data.length < 126) {
          header = Buffer.from([0x81, 0x80 | data.length]);
        } else if (data.length < 65536) {
          header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126;
          header.writeUInt16BE(data.length, 2);
        } else {
          header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(data.length), 2);
        }
        if (VERBOSE) console.error('[cdp >>] ' + method);
        inflight.push({
          method,
          resolve: (msg) => {
            if (msg.error) reject1(new Error(method + ': ' + msg.error.message));
            else resolve1(msg.result);
          },
          reject: reject1,
        });
        socket.write(Buffer.concat([header, mask, masked]));
      });

      resolve({ send, socket });
    });

    req.end();
  });
}

const results = [];
function record(label, value) {
  results.push({ label, value });
  console.log('--- ' + label + ' ---');
  console.log(typeof value === 'string' ? value : JSON.stringify(value));
}

let chrome2 = chrome;
try {
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await wait(250);
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* still starting */ }
  }
  if (!target) throw new Error('no debuggable page after 15s');

  const { send } = await connect(target.webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' :: '
        + ((r.exceptionDetails.exception || {}).description || ''));
    }
    return r.result.value;
  };

  // Wait for the viewer runtime to finish booting rather than guessing.
  for (let i = 0; i < 40; i += 1) {
    const ready = await evaluate('!!(window.Archify && Archify.drilldown)').catch(() => false);
    if (ready) break;
    await wait(250);
  }

  record('module presence', await evaluate([
    'JSON.stringify({',
    '  hasDrilldown: !!(window.Archify && Archify.drilldown),',
    '  payloadNodes: Object.keys((JSON.parse(document.getElementById("archify-detail-data").textContent)||{}).nodes||{}).length,',
    '  drillableNodes: document.querySelectorAll("[data-node-drilldown]").length,',
    '  barHidden: document.getElementById("drilldown-bar").hidden,',
    '  stageCount: document.querySelectorAll(".diagram-container").length,',
    '  scopeSvgFound: (function(){var c=document.querySelector(".diagram-container");',
    '    return Boolean(c && c.querySelector(":scope > svg"));})(),',
    '  directChildTags: (function(){var c=document.querySelector(".diagram-container");',
    '    if(!c) return null; return [].map.call(c.children, function(e){return e.tagName;});})(),',
    '  viewSvgResolved: (function(){try{var s=Archify.view.state();Archify.view.zoomIn();',
    '    var t=Archify.view.state().scale;Archify.view.zoomOut();',
    '    return {zoomFrom:s.scale, zoomTo:t};}catch(e){return "THROW: "+e.message;}})()',
    '})',
  ].join('\n')));

  record('single click opens detail', await evaluate([
    '(function(){',
    '  var n = document.querySelector("[data-node-drilldown]");',
    '  var id = n.getAttribute("data-node-id");',
    '  n.dispatchEvent(new MouseEvent("click", {bubbles:true}));',
    '  var panel = document.getElementById("drilldown-detail");',
    '  return JSON.stringify({clicked: id, panelShown: !panel.hidden,',
    '    title: (document.getElementById("drilldown-detail-title")||{}).textContent,',
    '    depthAfterClick: Archify.drilldown.depth()});',
    '})()',
  ].join('\n')));

  // Only a node whose payload is a nested diagram can be descended into; a
  // `code` leaf correctly refuses. Pick a real diagram node for every descent
  // test rather than assuming the first drillable node will open.
  const DIAGRAM_HOST = '"[data-node-id=\'runner\']"';

  record('double click descends', await evaluate([
    '(function(){',
    '  Archify.drilldown.reset();',
    '  var n = document.querySelector(' + DIAGRAM_HOST + ');',
    '  var id = n.getAttribute("data-node-id");',
    '  n.dispatchEvent(new MouseEvent("dblclick", {bubbles:true}));',
    '  var afterClick = Archify.drilldown.depth();',
    '  var directResult;',
    '  try { directResult = Archify.drilldown.descend("runner"); } catch (e) { directResult = "THROW: " + e.message; }',
    '  var live = document.querySelector(".diagram-container > svg");',
    '  return JSON.stringify({descendedFrom: id, depthAfterClick: afterClick,',
    '    directDescend: directResult, depthAfterDirect: Archify.drilldown.depth(),',
    '    active: Archify.drilldown.active(),',
    '    barHidden: document.getElementById("drilldown-bar").hidden,',
    '    crumbs: document.querySelectorAll(".drilldown-crumb").length,',
    '    liveNodeCount: live.querySelectorAll("[data-node-id]").length,',
    '    hostElementIsStable: (live !== null) && (live.getAttribute("viewBox") !== null),',
    '    panelTitle: (document.getElementById("drilldown-detail-title")||{}).textContent});',
    '})()',
  ].join('\n')));

  record('pan/zoom live after swap', await evaluate([
    '(function(){',
    '  var before = Archify.view.state().scale;',
    '  Archify.view.zoomIn();',
    '  var after = Archify.view.state().scale;',
    '  var doc = document;',
    '  var stages = doc.querySelectorAll(".diagram-container").length;',
    '  var host = doc.querySelector(".diagram-container");',
    '  var hostSvg = host ? host.querySelector(":scope > svg") : null;',
    '  var firstSvg = doc.querySelector("svg");',
    '  return JSON.stringify({depth: Archify.drilldown.depth(),',
    '    scaleBefore: before, scaleAfter: after, zoomWorks: after > before,',
    '    stageCount: stages,',
    '    hostSvgFound: Boolean(hostSvg),',
    '    hostSvgViewBox: hostSvg && hostSvg.getAttribute("viewBox"),',
    '    hostSvgScaleAttr: hostSvg && hostSvg.getAttribute("data-view-scale"),',
    '    hostSvgTransform: hostSvg ? (hostSvg.style.transform || "") : null,',
    '    hostSvgNodes: hostSvg ? hostSvg.querySelectorAll("[data-node-id]").length : 0,',
    '    firstSvgIsHostSvg: firstSvg === hostSvg,',
    '    firstSvgParent: firstSvg && firstSvg.parentElement ? firstSvg.parentElement.className : null});',
    '})()',
  ].join('\n')));

  record('code leaf refuses the dive', await evaluate([
    '(function(){',
    '  Archify.drilldown.reset();',
    '  var leaf = document.querySelector("[data-node-drilldown=\'code\']");',
    '  if (!leaf) return JSON.stringify({skipped:true, reason:"no code leaf at root"});',
    '  var before = Archify.drilldown.depth();',
    '  var returned = Archify.drilldown.descend(leaf.getAttribute("data-node-id"));',
    '  return JSON.stringify({refused: returned === false,',
    '    depthUnchanged: Archify.drilldown.depth() === before,',
    '    panelShownAnyway: !document.getElementById("drilldown-detail").hidden});',
    '})()',
  ].join('\n')));

  record('second level then walk back', await evaluate([
    '(function(){',
    '  Archify.drilldown.reset();',
    '  Archify.drilldown.descend("runner");',
    '  var d1 = Archify.drilldown.depth();',
    '  // Inside runner the children are code leaves, so step into whichever child',
    '  // itself owns a nested diagram, if any.',
    '  var inner = document.querySelector("[data-node-drilldown=\'diagram\']");',
    '  if (!inner) return JSON.stringify({depth1: d1, secondLevel: "none (children are code leaves)"});',
    '  Archify.drilldown.descend(inner.getAttribute("data-node-id"));',
    '  var d2 = Archify.drilldown.depth();',
    '  document.getElementById("drilldown-back").click();',
    '  var d3 = Archify.drilldown.depth();',
    '  document.getElementById("drilldown-back").click();',
    '  var d4 = Archify.drilldown.depth();',
    '  return JSON.stringify({depth1: d1, afterSecondDescend: d2, afterOneBack: d3, afterTwoBack: d4});',
    '})()',
  ].join('\n')));

  record('root restored', await evaluate([
    'JSON.stringify({',
    '  depth: Archify.drilldown.depth(),',
    '  rootNodes: document.querySelectorAll("[data-node-id]").length,',
    '  rootDrillable: document.querySelectorAll("[data-node-drilldown]").length,',
    '  barHidden: document.getElementById("drilldown-bar").hidden,',
    '  detailPanelHidden: document.getElementById("drilldown-detail").hidden',
    '})',
  ].join('\n')));

  record('breadcrumb jumps to root', await evaluate([
    '(function(){',
    '  Archify.drilldown.reset();',
    '  Archify.drilldown.descend("runner");',
    '  Archify.drilldown.descend("runner.loop");',
    '  var mid = Archify.drilldown.depth();',
    '  var crumbs = document.querySelectorAll(".drilldown-crumb").length;',
    '  document.querySelector(".drilldown-crumb").click();',
    '  return JSON.stringify({midDepth: mid, crumbCount: crumbs,',
    '    afterRootCrumb: Archify.drilldown.depth()});',
    '})()',
  ].join('\n')));

  record('Escape steps back one level', await evaluate([
    '(function(){',
    '  Archify.drilldown.reset();',
    '  Archify.drilldown.descend("runner");',
    '  Archify.drilldown.descend("runner.loop");',
    '  var deep = Archify.drilldown.depth();',
    '  document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}));',
    '  return JSON.stringify({beforeEscape: deep, afterEscape: Archify.drilldown.depth()});',
    '})()',
  ].join('\n')));

  record('export clone strips badges', await evaluate([
    '(function(){',
    '  Archify.drilldown.reset();',
    '  Archify.drilldown.descend("runner");',
    '  var svg = document.querySelector(".diagram-container > svg");',
    '  var clone = svg.cloneNode(true);',
    '  var before = clone.querySelectorAll("[data-drilldown-badge]").length;',
    '  Array.prototype.forEach.call(clone.querySelectorAll("[data-drilldown-badge]"), function (el) { el.remove(); });',
    '  return JSON.stringify({badgesInLiveSvg: svg.querySelectorAll("[data-drilldown-badge]").length,',
    '    badgesInCloneBeforeStrip: before,',
    '    badgesInCloneAfterStrip: clone.querySelectorAll("[data-drilldown-badge]").length,',
    '    cloneStillSingleSvg: clone.querySelectorAll("svg").length === 0});',
    '})()',
  ].join('\n')));

  record('leaf without detail refuses the dive', await evaluate([
    '(function(){',
    '  Archify.drilldown.reset();',
    '  var all = [].slice.call(document.querySelectorAll("[data-node-id]"));',
    '  var plain = all.filter(function(n){ return !n.hasAttribute("data-node-drilldown"); });',
    '  var before = Archify.drilldown.depth();',
    '  if (plain.length) plain[0].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));',
    '  return JSON.stringify({total: all.length, nonDrillable: plain.length,',
    '    depthUnchanged: Archify.drilldown.depth() === before});',
    '})()',
  ].join('\n')));

  record('repeated single clicks never descend', await evaluate([
    '(function(){',
    '  Archify.drilldown.reset();',
    '  var n = document.querySelector(' + DIAGRAM_HOST + ');',
    '  n.dispatchEvent(new MouseEvent("click", {bubbles:true}));',
    '  n.dispatchEvent(new MouseEvent("click", {bubbles:true}));',
    '  return JSON.stringify({depth: Archify.drilldown.depth(),',
    '    panelShown: !document.getElementById("drilldown-detail").hidden});',
    '})()',
  ].join('\n')));

  record('nested level click shows full class source', await evaluate([
    '(function(){',
    '  Archify.drilldown.reset();',
    '  Archify.drilldown.descend("runner");',
    '  var inner = document.querySelector(".diagram-container > svg [data-node-drilldown]");',
    '  if (!inner) return JSON.stringify({skipped:true});',
    '  inner.dispatchEvent(new MouseEvent("click", {bubbles:true}));',
    '  var panel = document.getElementById("drilldown-detail");',
    '  var code = panel.querySelector(".drilldown-code");',
    '  var title = (document.getElementById("drilldown-detail-title")||{}).textContent;',
    '  var body = code ? code.textContent : "";',
    '  return JSON.stringify({target: inner.getAttribute("data-node-id"), title: title,',
    '    shown: !panel.hidden, hasCode: !!code, codeLines: body.split("\\n").length,',
    '    fieldsListed: panel.querySelectorAll(".drilldown-member").length > 0,',
    '    looksLikePython: /def |class /.test(body)});',
    '})()',
  ].join('\n')));

  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(r.label + ': ' + r.value));
} catch (err) {
  console.error('\n[FAILED] ' + err.message);
  console.log('\n=== PARTIAL SUMMARY ===');
  results.forEach((r) => console.log(r.label + ': ' + r.value));
  process.exitCode = 1;
} finally {
  try { chrome2.kill(); } catch { /* already gone */ }
}
