// Optional UI smoke check. Start server.mjs and a local Chrome with --remote-debugging-port=9224.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';

const target = await (await fetch('http://127.0.0.1:9224/json/new?http://127.0.0.1:4173/', {method:'PUT'})).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map(), events = new Map(), errors = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const callbacks = pending.get(message.id); pending.delete(message.id);
    if (callbacks) { if (message.error) callbacks.reject(new Error(message.error.message)); else callbacks.resolve(message.result); }
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  events.get(message.method)?.();
};
function call(method, params = {}) { return new Promise((resolve, reject) => { const seq = ++id; const timeout = setTimeout(() => { pending.delete(seq); reject(new Error(`CDP timeout: ${method}`)); }, 10000); pending.set(seq, {resolve:result => {clearTimeout(timeout); resolve(result);},reject:error => {clearTimeout(timeout); reject(error);}}); ws.send(JSON.stringify({id:seq, method, params})); }); }
async function reload() {
  const loaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
  let timeout;
  try {
    await call('Page.reload');
    await Promise.race([loaded, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Reload timeout')), 10000); })]);
  } finally { clearTimeout(timeout); events.delete('Page.loadEventFired'); }
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  for (let n = 0; n < 80; n++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timeout: ${expression}`);
}
try {
  await call('Runtime.enable'); await call('Page.enable');
  await waitFor(`document.querySelector('#today-label')?.textContent.length > 0`);
  await evaluate(`localStorage.clear()`); await reload();
  await waitFor(`document.querySelector('#total-balance')?.textContent.includes('0,00')`);
  await evaluate(`document.querySelector('#initial-button').click(); document.querySelector('#settings-form').elements.balance.value = '400,00'; document.querySelector('#settings-form').requestSubmit()`);
  await waitFor(`!document.querySelector('#settings-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /400,00/);
  await evaluate(`{document.querySelector('#new-transaction').click(); const f=document.querySelector('#transaction-form'); f.elements.amount.value='50,00'; f.elements.description.value='Mercado <script>teste</script>'; f.requestSubmit()}`);
  await waitFor(`document.querySelectorAll('#transaction-rows tr').length === 1`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /350,00/);
  assert.equal(await evaluate(`document.querySelector('#transaction-rows script') === null`), true);
  await evaluate(`{document.querySelector('[data-edit]').click(); const f=document.querySelector('#transaction-form'); f.elements.amount.value='25,50'; f.requestSubmit()}`);
  await waitFor(`!document.querySelector('#transaction-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /374,50/);
  await evaluate(`document.querySelector('[data-filter="income"]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('#transaction-rows tr').length`), 0);
  await evaluate(`document.querySelector('[data-filter="all"]').click()`); await reload();
  await waitFor(`document.querySelector('#total-balance')?.textContent.includes('374,50')`);
  assert.equal(await evaluate(`document.querySelectorAll('#transaction-rows tr').length`), 1);
  await evaluate(`document.querySelector('[data-delete]').click()`);
  await waitFor(`document.querySelector('#confirm-dialog').open`);
  await evaluate(`document.querySelector('#confirm-ok').click()`);
  await waitFor(`document.querySelectorAll('#transaction-rows tr').length === 0`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /400,00/);
  await evaluate(`{document.querySelector('#new-transaction').click(); const f=document.querySelector('#transaction-form'); f.elements.type.value='income'; f.elements.category.value='Salário'; f.elements.amount.value='100,00'; f.elements.description.value='Pagamento'; f.requestSubmit()}`);
  await waitFor(`!document.querySelector('#transaction-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /500,00/);
  assert.match(await evaluate(`document.querySelector('#month-income').textContent`), /100,00/);
  await evaluate(`document.querySelector('#export-button').click()`);
  assert.equal(await evaluate(`document.querySelector('#toast').textContent.includes('Backup exportado')`), true);
  await evaluate(`{document.querySelector('#settings-button').click(); const backup=JSON.parse(localStorage.getItem('semana:local:v1')); backup.initialBalance=60000; backup.transactions=[]; const transfer=new DataTransfer(); transfer.items.add(new File([JSON.stringify(backup)],'backup.json',{type:'application/json'})); const input=document.querySelector('#import-input'); input.files=transfer.files; input.dispatchEvent(new Event('change'));}`);
  await waitFor(`document.querySelector('#confirm-dialog').open`);
  await evaluate(`document.querySelector('#confirm-ok').click()`);
  await waitFor(`!document.querySelector('#settings-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /600,00/);
  await evaluate(`document.querySelector('#sync-button').click()`);
  assert.equal(await evaluate(`document.querySelector('#cloud-dialog').open`), true);
  assert.equal(await evaluate(`document.querySelector('#cloud-form [name=config]') === null`), true);
  await evaluate(`document.querySelector('#cloud-dialog').close()`);
  const cloudPath = (await readFile('dist/app.js', 'utf8')).match(/import\("(\.\/assets\/cloud-[^"]+)"\)/)?.[1];
  assert.ok(cloudPath, 'Firebase must remain in a separate lazy-loaded bundle');
  assert.equal(await evaluate(`import(${JSON.stringify(cloudPath)}).then(module => module.connectCloud())`), null);
  await call('Emulation.setDeviceMetricsOverride', {width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await evaluate(`localStorage.clear()`); await reload();
  await waitFor(`document.querySelector('#today-label')?.textContent.length > 0`);
  const desktop = await call('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
  await writeFile('qa-desktop.png', Buffer.from(desktop.data, 'base64'));
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
  await call('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
  const mobile = await call('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
  await writeFile('qa-mobile.png', Buffer.from(mobile.data, 'base64'));
  assert.deepEqual(errors, []);
  console.log('UI OK: finanças, persistência, backups, desktop/mobile e SDK Firebase npm carregado sem sessão.');
} finally { await call('Page.close').catch(() => {}); ws.close(); }
