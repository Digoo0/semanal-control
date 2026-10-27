import {calculate, dateKey, parseDate, addDays, nextPayday, newState, validateState, MAX_CENTS} from './budget.js';
import {firebaseConfig} from './firebase-config.js';

const $ = selector => document.querySelector(selector);
const LOCAL_KEY = 'semana:local:v1';
const CONFIG_KEY = 'semana:firebase:v1';
const money = cents => (cents / 100).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
const shortDate = key => parseDate(key).toLocaleDateString('pt-BR', {day:'2-digit', month:'short'}).replace('.', '');
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let cloud = null, filter = 'all', busy = false, toastTimer;
let startupError = '';
function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? validateState(JSON.parse(raw)) : newState();
  } catch { startupError = 'Não foi possível ler os dados locais. O arquivo original foi preservado. Importe um backup ou verifique o armazenamento do navegador.'; return null; }
}
let state = readLocal();
let localBroken = !state;
state ||= newState();
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5500);
}
function setStatus(message, error = false) {
  $('#sync-label').textContent = message;
  $('.storage-status .tiny-dot').style.background = error ? '#bd7652' : '';
}
function parseMoney(value, allowNegative = false) {
  const text = value.trim().replace(/\s/g, '');
  if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text)) throw new Error('Use um valor como 50,00 ou 1.250,50.');
  const cents = Math.round(Number(text.replaceAll('.', '').replace(',', '.')) * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS || (!allowNegative && cents <= 0)) throw new Error('Informe um valor válido maior que zero.');
  return cents;
}
function download(data, name = `semana-backup-${dateKey()}.json`) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function commit(next) {
  if (busy) throw new Error('Aguarde a operação atual terminar.');
  if (localBroken && !cloud) throw new Error('O armazenamento local precisa ser recuperado antes de salvar. Exporte ou recupere seus dados primeiro.');
  validateState(next);
  busy = true;
  try {
    if (cloud) {
      setStatus('Salvando na nuvem…');
      await cloud.save(next);
      // A local cache is best-effort; a successful remote commit must not be retried.
      try { localStorage.setItem(`semana:cloud:${cloud.uid}`, JSON.stringify(next)); } catch {}
    } else localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
    state = next; render();
  } catch (error) {
    setStatus(cloud ? 'Falha ao sincronizar' : 'Falha ao salvar', true);
    throw new Error(error.code ? friendlyError(error) : error.message || 'Não foi possível salvar.');
  } finally { busy = false; }
}
function render() {
  const today = dateKey(), budget = calculate(state, today);
  const date = parseDate(today);
  $('#today-label').textContent = date.toLocaleDateString('pt-BR', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
  document.querySelectorAll('.current-month').forEach(el => el.textContent = date.toLocaleDateString('pt-BR', {month:'long'}));
  $('#total-balance').textContent = money(budget.total);
  $('#month-income').textContent = money(budget.income);
  $('#month-expense').textContent = money(budget.expense);
  $('#welcome-strip').hidden = state.initialized;
  $('#week-count').textContent = `${budget.periods.length} ${budget.periods.length === 1 ? 'semana' : 'semanas'}`;
  const maximum = Math.max(...budget.periods.map(w => w.amount), 1);
  $('#weeks').innerHTML = budget.periods.map((week, index) => `<div class="week-card ${index === 0 ? 'current' : ''}"><div class="week-title">${index === 0 ? '<span class="tiny-dot"></span> Semana atual' : `Semana ${index + 1}`}</div><div class="week-date">${shortDate(week.start)} – ${shortDate(week.end)}</div><div class="week-amount ${week.amount < 0 ? 'negative' : ''}">${escapeHtml(money(week.amount))}</div><div class="week-bar"><i style="width:${Math.max(0, Math.min(100, week.amount / maximum * 100))}%"></i></div><div class="week-foot">${index === 0 ? week.amount < 0 ? 'Limite ultrapassado' : 'Disponível para usar' : 'Reservado para depois'}</div></div>`).join('');
  $('#payday-label').textContent = parseDate(budget.payday).toLocaleDateString('pt-BR', {day:'2-digit', month:'long'});
  const days = Math.round((Date.UTC(...budget.payday.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) - Date.UTC(...today.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)))) / 86400000);
  $('#payday-count').textContent = `Falta${days === 1 ? '' : 'm'} ${days} dia${days === 1 ? '' : 's'}`;
  setStatus(cloud ? 'Salvo na sua conta' : 'Salvo neste dispositivo');
  $('#account-label').textContent = cloud ? cloud.email : 'Espaço pessoal';
  $('#footer-storage').textContent = cloud ? 'Seus dados sincronizados com Firebase.' : 'Seus dados ficam neste navegador.';
  renderTransactions();
}
function renderTransactions() {
  const search = $('#search').value.trim().toLocaleLowerCase('pt-BR');
  const items = state.transactions.map((t, index) => ({...t, index})).filter(t => (filter === 'all' || filter === t.type) && `${t.description} ${t.category}`.toLocaleLowerCase('pt-BR').includes(search)).sort((a, b) => b.date.localeCompare(a.date) || b.index - a.index);
  $('#transaction-rows').innerHTML = items.map(t => `<tr><td><div class="entry-name"><span class="entry-icon ${t.type}" aria-hidden="true">${t.type === 'income' ? '↙' : '↗'}</span><span title="${escapeHtml(t.description)}">${escapeHtml(t.description)}</span></div></td><td><span class="category-pill">${escapeHtml(t.category)}</span></td><td>${parseDate(t.date).toLocaleDateString('pt-BR')}</td><td class="amount-column ${t.type === 'income' ? 'income-amount' : ''}">${t.type === 'income' ? '+' : '−'} ${escapeHtml(money(t.amount))}</td><td class="row-actions"><button class="row-action" data-edit="${escapeHtml(t.id)}" aria-label="Editar ${escapeHtml(t.description)}" title="Editar">✎</button><button class="row-action" data-delete="${escapeHtml(t.id)}" aria-label="Excluir ${escapeHtml(t.description)}" title="Excluir">×</button></td></tr>`).join('');
  $('#transaction-count').textContent = `${items.length} ${items.length === 1 ? 'movimentação' : 'movimentações'}`;
  $('#empty-state').hidden = items.length > 0;
  $('#empty-state h3').textContent = state.transactions.length ? 'Nenhuma movimentação encontrada' : 'Aqui começa sua organização';
  $('#empty-state p').textContent = state.transactions.length ? 'Tente outra busca ou altere o filtro.' : 'Registre uma entrada ou saída para acompanhar seu dinheiro.';
}
function openDialog(id) { const dialog = $(id); dialog.querySelectorAll('.form-error').forEach(el => el.textContent = ''); dialog.showModal(); }
function transactionDialog(id) {
  const form = $('#transaction-form'); form.reset();
  form.elements.id.value = '';
  form.elements.date.min = state.startedOn; form.elements.date.max = dateKey(); form.elements.date.value = dateKey();
  const transaction = state.transactions.find(t => t.id === id);
  if (transaction) {
    for (const field of ['id','type','description','category','date']) form.elements[field].value = transaction[field];
    form.elements.amount.value = (transaction.amount / 100).toFixed(2).replace('.', ',');
  }
  $('#transaction-title').textContent = transaction ? 'Editar movimentação' : 'Nova movimentação';
  openDialog('#transaction-dialog');
  form.elements.amount.focus();
}
function settingsDialog() {
  const form = $('#settings-form');
  form.elements.balance.value = (state.initialBalance / 100).toFixed(2).replace('.', ',');
  form.elements.payday.value = nextPayday(dateKey(), state.paydayOverrides);
  form.elements.payday.min = addDays(dateKey(), 1);
  const next = parseDate(nextPayday(dateKey()));
  form.elements.payday.max = dateKey(new Date(next.getFullYear(), next.getMonth() + 1, 0, 12));
  $('#balance-hint').textContent = `Saldo inicial em ${parseDate(state.startedOn).toLocaleDateString('pt-BR')}. Entradas e saídas são somadas a ele. Alterar este valor recalcula todo o histórico.`;
  openDialog('#settings-dialog');
}
function askConfirmation(title, message) {
  return new Promise(resolve => {
    const dialog = $('#confirm-dialog');
    $('#confirm-title').textContent = title; $('#confirm-message').textContent = message;
    let answer = false;
    $('#confirm-ok').onclick = () => { answer = true; dialog.close(); };
    $('#confirm-cancel').onclick = () => dialog.close();
    dialog.addEventListener('close', () => resolve(answer), {once:true});
    dialog.showModal();
  });
}
function friendlyError(error) {
  const messages = {'auth/invalid-credential':'E-mail ou senha inválidos.','auth/email-already-in-use':'Este e-mail já tem uma conta. Desmarque a opção de criar conta.','auth/operation-not-allowed':'Habilite o acesso por e-mail e senha no Firebase Authentication.','auth/unauthorized-domain':'Autorize o domínio deste site no Firebase Authentication.','auth/network-request-failed':'Não foi possível conectar. Verifique sua internet.','auth/too-many-requests':'Muitas tentativas. Aguarde um pouco e tente novamente.','permission-denied':'Acesso negado. Publique as regras do arquivo firestore.rules no seu projeto.','unavailable':'Firebase indisponível. Tente novamente quando estiver conectado.'};
  return messages[error.code] || error.message || 'Não foi possível conectar ao Firebase.';
}
async function activateCloud(adapter, interactive = false) {
  const remote = await adapter.load();
  if (remote) validateState(remote);
  if (interactive && remote && (state.initialized || state.transactions.length)) download(state, `semana-antes-da-conexao-${dateKey()}.json`);
  if (!remote) await adapter.save(state);
  cloud = adapter; state = remote || state;
  try { localStorage.setItem(CONFIG_KEY, firebaseConfig.projectId); } catch {}
  render();
}
$('#new-transaction').onclick = () => transactionDialog();
$('#empty-add').onclick = () => transactionDialog();
$('#initial-button').onclick = settingsDialog;
$('#settings-button').onclick = settingsDialog;
$('#payday-button').onclick = settingsDialog;
$('#how-button').onclick = () => openDialog('#info-dialog');
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));
document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => {
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b === button)); renderTransactions();
});
$('#search').addEventListener('input', renderTransactions);
document.querySelectorAll('a.nav-link').forEach(link => link.onclick = () => document.querySelectorAll('a.nav-link').forEach(l => l.classList.toggle('active', l === link)));
$('#transaction-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const data = new FormData(form), id = data.get('id') || crypto.randomUUID();
    const entry = {id, type:data.get('type'), description:data.get('description').trim(), category:data.get('category'), date:data.get('date'), amount:parseMoney(data.get('amount'))};
    const next = structuredClone(state), existing = next.transactions.findIndex(t => t.id === id);
    if (existing >= 0) next.transactions[existing] = entry; else next.transactions.push(entry);
    next.initialized = true;
    await commit(next); $('#transaction-dialog').close(); toast('Movimentação salva. Seu plano está atualizado.');
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#settings-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const balance = parseMoney(form.elements.balance.value, true), payday = form.elements.payday.value;
    parseDate(payday);
    if (payday <= dateKey() || payday > form.elements.payday.max) throw new Error('Escolha uma data futura até o final do mês de recebimento.');
    if (state.initialized && balance !== state.initialBalance && !await askConfirmation('Alterar saldo inicial?', 'O saldo disponível e todas as divisões semanais serão recalculados a partir do início do histórico.')) return;
    const next = structuredClone(state); next.initialBalance = balance; next.initialized = true;
    for (const [month, date] of Object.entries(next.paydayOverrides)) if (date > dateKey()) delete next.paydayOverrides[month];
    next.paydayOverrides[payday.slice(0, 7)] = payday;
    await commit(next); $('#settings-dialog').close(); toast('Planejamento atualizado.');
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#transaction-rows').onclick = async event => {
  const edit = event.target.closest('[data-edit]'), remove = event.target.closest('[data-delete]');
  if (edit) transactionDialog(edit.dataset.edit);
  if (remove && await askConfirmation('Excluir movimentação?', 'O lançamento será removido e seu saldo será recalculado.')) {
    try { const next = structuredClone(state); next.transactions = next.transactions.filter(t => t.id !== remove.dataset.delete); await commit(next); toast('Movimentação excluída.'); }
    catch (error) { toast(error.message); }
  }
};
$('#export-button').onclick = () => { download(state); toast('Backup exportado com todo o histórico.'); };
$('#import-input').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('O arquivo deve ter no máximo 5 MB.');
    const imported = validateState(JSON.parse(await file.text()));
    if (!await askConfirmation('Restaurar backup?', 'Os dados atuais serão exportados como backup e substituídos pelos dados deste arquivo.')) return;
    download(localBroken ? {original: localStorage.getItem(LOCAL_KEY)} : state, `semana-antes-da-importacao-${dateKey()}.json`);
    const wasBroken = localBroken;
    localBroken = false;
    try { await commit(imported); } catch (error) { localBroken = wasBroken; throw error; }
    $('#settings-dialog').close(); toast('Backup restaurado.');
  } catch (error) { toast(error.message || 'Arquivo inválido.'); }
  finally { event.target.value = ''; }
};
function cloudDialog() {
  $('#settings-dialog').close();
  const form = $('#cloud-form'); form.hidden = !!cloud;
  $('#disconnect-button').hidden = !cloud;
  openDialog('#cloud-dialog');
}
$('#cloud-button').onclick = cloudDialog;
$('#sync-button').onclick = cloudDialog;
$('#cloud-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const {connectCloud} = await import('./cloud.js');
    const adapter = await connectCloud({email:form.elements.email.value.trim(), password:form.elements.password.value, createAccount:form.elements.createAccount.checked});
    await activateCloud(adapter, true);
    form.elements.password.value = ''; $('#cloud-dialog').close(); toast('Conectado. Suas alterações serão salvas no Firebase.');
  } catch (error) { form.querySelector('.form-error').textContent = friendlyError(error); }
  finally { button.disabled = false; }
};
$('#disconnect-button').onclick = async () => {
  if (busy) return toast('Aguarde o salvamento terminar.');
  try {
    await cloud.disconnect(); cloud = null; localStorage.removeItem(CONFIG_KEY);
    state = readLocal() || newState(); $('#cloud-dialog').close(); render(); toast('Você voltou aos dados locais deste dispositivo.');
  } catch (error) { toast(friendlyError(error)); }
};
render();
if (startupError) { setStatus('Verifique os dados locais', true); toast(startupError); }
let lastDay = dateKey();
setInterval(() => { if (dateKey() !== lastDay) { lastDay = dateKey(); render(); } }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
async function resumeCloud() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY); if (raw !== firebaseConfig.projectId) return;
    busy = true; setStatus('Conectando ao Firebase…');
    document.querySelectorAll('#new-transaction,#initial-button,#settings-button,#payday-button,#empty-add,#sync-button').forEach(b => b.disabled = true);
    const {connectCloud} = await import('./cloud.js');
    const adapter = await connectCloud();
    if (adapter) await activateCloud(adapter);
    else { setStatus('Sessão encerrada · dados locais'); toast('Entre novamente no Firebase para acessar os dados da sua conta.'); }
  } catch (error) { setStatus('Nuvem indisponível · dados locais', true); toast(friendlyError(error)); }
  finally { busy = false; document.querySelectorAll('#new-transaction,#initial-button,#settings-button,#payday-button,#empty-add,#sync-button').forEach(b => b.disabled = false); }
}
resumeCloud();
