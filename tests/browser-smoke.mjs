// Start server.mjs and an isolated Chrome with --remote-debugging-port=9224.
// Authentication and Firestore writes are simulated at the SDK module boundary.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';

const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4173/';
const target = await (await fetch(`http://127.0.0.1:9224/json/new?${encodeURIComponent(base)}`, {method:'PUT'})).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map(), events = new Map(), errors = [];
let cloudStub = null;
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const callbacks = pending.get(message.id); pending.delete(message.id);
    if (callbacks) { if (message.error) callbacks.reject(new Error(message.error.message)); else callbacks.resolve(message.result); }
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  if (message.method === 'Fetch.requestPaused') {
    call('Fetch.fulfillRequest', {requestId:message.params.requestId, responseCode:200, responseHeaders:[{name:'Content-Type',value:'text/javascript; charset=utf-8'}], body:Buffer.from(cloudStub).toString('base64')}).catch(error => errors.push(error.message));
  }
  events.get(message.method)?.();
};
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const seq = ++id;
    const timeout = setTimeout(() => { pending.delete(seq); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(seq, {resolve:result => {clearTimeout(timeout); resolve(result);},reject:error => {clearTimeout(timeout); reject(error);}});
    ws.send(JSON.stringify({id:seq, method, params}));
  });
}
async function reload() {
  const loaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
  let timeout;
  try { await call('Page.reload'); await Promise.race([loaded, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Reload timeout')), 10000); })]); }
  finally { clearTimeout(timeout); events.delete('Page.loadEventFired'); }
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  for (let n = 0; n < 150; n++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  const detail = await evaluate(`({auth:document.body.dataset.auth,status:document.querySelector('#login-status')?.textContent,error:document.querySelector('#login-form .form-error')?.textContent,resetDisabled:document.querySelector('#reset-password')?.disabled})`);
  throw new Error(`Timeout: ${expression} ${JSON.stringify(detail)}`);
}
async function login(email = 'teste@example.com', password = 'teste123') {
  await evaluate(`{const form=document.querySelector('#login-form'); form.elements.email.value=${JSON.stringify(email)}; form.elements.password.value=${JSON.stringify(password)}; form.requestSubmit();}`);
}
try {
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
  await call('Network.setCacheDisabled', {cacheDisabled:true});
  await waitFor(`document.body.dataset.auth === 'signed-out'`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#overview')).display`), 'none');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#app-sidebar')).display`), 'none');
  assert.equal(await evaluate(`document.querySelector('#login-submit').disabled`), false);

  cloudStub = `
    export async function connectCloud(credentials) {
      if (credentials?.email === 'erro@example.com') throw {code:'auth/invalid-credential'};
      if (credentials) sessionStorage.setItem('qa:account', credentials.email);
      const email = sessionStorage.getItem('qa:account');
      if (!email) return null;
      const key = 'qa:state:' + email;
      return {email,uid:email,
        async load() { if (sessionStorage.getItem('qa:load-failure')) throw {code:'permission-denied'}; return JSON.parse(sessionStorage.getItem(key) || 'null'); },
        async save(state) { if (sessionStorage.getItem('qa:save-failure')) throw {code:'unavailable'}; sessionStorage.setItem(key, JSON.stringify(state)); },
        async disconnect() { sessionStorage.removeItem('qa:account'); globalThis.qaSignedOut?.(); },
        onSignedOut(callback) { globalThis.qaSignedOut = callback; return () => { globalThis.qaSignedOut = null; }; }
      };
    }
    export async function resetPassword(email) { sessionStorage.setItem('qa:reset-email', email); }
  `;
  await call('Fetch.enable', {patterns:[{urlPattern:'*assets/cloud-*.js',requestStage:'Request'}]});
  await evaluate(`localStorage.clear(); sessionStorage.clear()`); await reload();
  await waitFor(`document.body.dataset.auth === 'signed-out' && !document.querySelector('#login-submit').disabled`);
  await login('erro@example.com');
  await waitFor(`document.querySelector('#login-form .form-error').textContent.includes('inválidos')`);
  assert.equal(await evaluate(`document.querySelector('#overview').hidden`), true);
  await evaluate(`sessionStorage.setItem('qa:load-failure', '1')`);
  await login();
  await waitFor(`document.querySelector('#login-form .form-error').textContent.includes('Firestore')`);
  assert.equal(await evaluate(`document.querySelector('#overview').hidden`), true);
  await evaluate(`sessionStorage.removeItem('qa:load-failure')`);
  await login(); await waitFor(`document.body.dataset.auth === 'authenticated'`);
  assert.equal(await evaluate(`document.querySelector('#login-screen').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('[data-page="overview"]').hidden`), false);
  assert.equal(await evaluate(`document.querySelector('#forecast').hidden`), true);
  await evaluate(`document.querySelector('a.nav-link[href="#forecast"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#forecast').hidden`), false);
  assert.equal(await evaluate(`document.querySelector('[data-page="overview"]').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('#page-title').textContent`), 'Previsão');
  await evaluate(`document.querySelector('a.nav-link[href="#transactions"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#transactions').hidden`), false);
  assert.equal(await evaluate(`document.querySelector('#forecast').hidden`), true);
  await evaluate(`history.back()`);
  await waitFor(`location.hash === '#forecast' && !document.querySelector('#forecast').hidden`);
  await evaluate(`document.querySelector('a.nav-link[href="#overview"]').click()`);
  await evaluate(`document.querySelector('#initial-button').click(); document.querySelector('#settings-form').elements.balance.value = '400,00'; document.querySelector('#settings-form').requestSubmit()`);
  await waitFor(`document.querySelector('#total-balance').textContent.includes('400,00')`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /400,00/);
  await evaluate(`{document.querySelector('#new-transaction').click();const f=document.querySelector('#transaction-form');f.elements.amount.value='100,00';f.elements.description.value='Conta futura';const d=new Date(f.elements.date.value+'T12:00:00');d.setDate(d.getDate()+10);f.elements.date.value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');f.requestSubmit();}`);
  await waitFor(`document.querySelector('#reserved-balance').textContent.includes('100,00') && !document.querySelector('#transaction-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#available-balance').textContent`), /300,00/);
  assert.ok(await evaluate(`JSON.parse(sessionStorage.getItem('qa:state:teste@example.com')).transactions[0].reservedFrom`));
  await evaluate(`document.querySelector('[data-delete]').click()`); await waitFor(`document.querySelector('#confirm-dialog').open`);
  await evaluate(`document.querySelector('#confirm-ok').click()`); await waitFor(`document.querySelector('#reserved-balance').textContent.includes('0,00') && document.querySelectorAll('#transaction-rows tr').length===0`);
  assert.match(await evaluate(`document.querySelector('#available-balance').textContent`), /400,00/);
  await evaluate(`{document.querySelector('#new-transaction').click(); const f=document.querySelector('#transaction-form'); f.elements.amount.value='50,00'; f.elements.description.value='Mercado <script>teste</script>'; f.requestSubmit();}`);
  await waitFor(`document.querySelectorAll('#transaction-rows tr').length === 1`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /350,00/);
  assert.equal(await evaluate(`document.querySelector('#transaction-rows script') === null`), true);
  await evaluate(`{document.querySelector('[data-edit]').click(); const f=document.querySelector('#transaction-form'); f.elements.amount.value='25,50'; f.requestSubmit();}`);
  await waitFor(`!document.querySelector('#transaction-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /374,50/);
  await evaluate(`document.querySelector('[data-filter="income"]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('#transaction-rows tr').length`), 0);
  await reload(); await waitFor(`document.body.dataset.auth === 'authenticated'`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /374,50/);
  await evaluate(`document.querySelector('[data-delete]').click()`); await waitFor(`document.querySelector('#confirm-dialog').open`);
  await evaluate(`document.querySelector('#confirm-ok').click()`); await waitFor(`document.querySelectorAll('#transaction-rows tr').length === 0`);
  await evaluate(`{document.querySelector('#new-transaction').click(); const f=document.querySelector('#transaction-form'); f.elements.type.value='income'; f.elements.category.value='Salário'; f.elements.amount.value='100,00'; f.elements.description.value='Pagamento'; f.requestSubmit();}`);
  await waitFor(`!document.querySelector('#transaction-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /500,00/);
  await evaluate(`sessionStorage.setItem('qa:save-failure','1'); document.querySelector('[data-delete]').click()`);
  await waitFor(`document.querySelector('#confirm-dialog').open`); await evaluate(`document.querySelector('#confirm-ok').click()`);
  await waitFor(`document.querySelector('#sync-label').textContent.includes('Falha')`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /500,00/);
  await evaluate(`sessionStorage.removeItem('qa:save-failure'); document.querySelector('#export-button').click()`);
  assert.equal(await evaluate(`document.querySelector('#toast').textContent.includes('Backup exportado')`), true);
  await evaluate(`{document.querySelector('a[href="#settings"]').click(); const backup=JSON.parse(sessionStorage.getItem('qa:state:teste@example.com')); backup.initialBalance=60000; backup.transactions=[]; const transfer=new DataTransfer(); transfer.items.add(new File([JSON.stringify(backup)],'backup.json',{type:'application/json'})); const input=document.querySelector('#import-input'); input.files=transfer.files; input.dispatchEvent(new Event('change'));}`);
  await waitFor(`document.querySelector('#confirm-dialog').open`); await evaluate(`document.querySelector('#confirm-ok').click()`);
  await waitFor(`document.querySelector('#total-balance').textContent.includes('600,00')`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /600,00/);
  await evaluate(`document.querySelector('#logout-button').click()`); await waitFor(`document.body.dataset.auth === 'signed-out' && !document.querySelector('#logout-button').disabled`);
  assert.equal(await evaluate(`document.querySelector('#overview').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('#login-form').elements.password.value`), '');
  await evaluate(`document.querySelector('#login-form').elements.email.value = 'teste@example.com'; document.querySelector('#reset-password').click()`);
  await waitFor(`document.querySelector('#login-status').textContent.includes('instruções')`);
  assert.equal(await evaluate(`sessionStorage.getItem('qa:reset-email')`), 'teste@example.com');
  await evaluate(`document.querySelector('#login-toggle').click()`);
  assert.equal(await evaluate(`document.querySelector('#login-form').elements.password.autocomplete`), 'new-password');
  await login('outra@example.com'); await waitFor(`document.body.dataset.auth === 'authenticated'`);
  assert.match(await evaluate(`document.querySelector('#total-balance').textContent`), /0,00/);
  assert.equal(await evaluate(`document.querySelectorAll('#transaction-rows tr').length`), 0);
  await evaluate(`document.querySelector('#logout-button').click()`); await waitFor(`document.body.dataset.auth === 'signed-out'`);
  await reload(); await waitFor(`document.body.dataset.auth === 'signed-out'`);
  for (const [name,width,height,mobile] of [['desktop',1440,1000,false],['mobile',390,844,true]]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile});
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    const screenshot = await call('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
    await writeFile(`qa-login-${name}.png`, Buffer.from(screenshot.data, 'base64'));
  }
  assert.deepEqual(errors, []);
  assert.match(await readFile('dist/app.js','utf8'), /\.\/assets\/cloud-/);
  console.log('UI OK: login inicial, erros de acesso, sessão restaurada, logout, isolamento de contas, recuperação de senha, cadastro, finanças e backups; desktop/mobile sem overflow. Backend simulado; SDK real inicializado sem sessão.');
} finally { await call('Page.close').catch(() => {}); ws.close(); }
