import {calculate, dateKey, parseDate, addDays, nextPayday, newState, validateState, MAX_CENTS, MAX_SCHEDULE_DAYS} from './budget.js';

const $ = selector => document.querySelector(selector);
const money = cents => (cents / 100).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
const shortDate = key => parseDate(key).toLocaleDateString('pt-BR', {day:'2-digit', month:'short'}).replace('.', '');
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let cloud = null, filter = 'all', busy = false, toastTimer, unsubscribeAuth;
let state = newState(), creatingAccount = false;
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
  if (!cloud) throw new Error('Entre na sua conta para salvar seu planejamento.');
  validateState(next);
  busy = true;
  try {
    const adapter = cloud;
    setStatus('Salvando na nuvem…');
    await adapter.save(next);
    if (cloud !== adapter) throw new Error('Sua sessão foi encerrada. Entre novamente.');
    state = next; render();
  } catch (error) {
    setStatus('Falha ao sincronizar', true);
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
  $('#weeks').innerHTML = budget.periods.map((week, index) => {
    const planned = state.transactions.filter(t => t.date > today && t.date >= week.start && t.date <= week.end).length;
    const detail = planned ? `Previsto · ${planned} agendado${planned === 1 ? '' : 's'}` : index === 0 ? week.amount < 0 ? 'Limite ultrapassado' : 'Disponível para usar' : 'Reservado para depois';
    return `<div class="week-card ${index === 0 ? 'current' : ''}"><div class="week-title">${index === 0 ? '<span class="tiny-dot"></span> Semana atual' : `Semana ${index + 1}`}</div><div class="week-date">${shortDate(week.start)} – ${shortDate(week.end)}</div><div class="week-amount ${week.amount < 0 ? 'negative' : ''}">${escapeHtml(money(week.amount))}</div><div class="week-bar"><i style="width:${Math.max(0, Math.min(100, week.amount / maximum * 100))}%"></i></div><div class="week-foot ${planned ? 'scheduled-text' : ''}">${detail}</div></div>`;
  }).join('');
  $('#payday-label').textContent = parseDate(budget.payday).toLocaleDateString('pt-BR', {day:'2-digit', month:'long'});
  const days = Math.round((Date.UTC(...budget.payday.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) - Date.UTC(...today.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)))) / 86400000);
  $('#payday-count').textContent = `Falta${days === 1 ? '' : 'm'} ${days} dia${days === 1 ? '' : 's'}`;
  setStatus(cloud ? 'Salvo na sua conta' : 'Entre na sua conta');
  $('#account-label').textContent = cloud ? cloud.email : 'Espaço pessoal';
  $('#footer-storage').textContent = 'Seu planejamento salvo na sua conta.';
  renderTransactions();
}
function renderTransactions() {
  const search = $('#search').value.trim().toLocaleLowerCase('pt-BR');
  const items = state.transactions.map((t, index) => ({...t, index})).filter(t => (filter === 'all' || filter === t.type) && `${t.description} ${t.category}`.toLocaleLowerCase('pt-BR').includes(search)).sort((a, b) => b.date.localeCompare(a.date) || b.index - a.index);
  $('#transaction-rows').innerHTML = items.map(t => { const scheduled = t.date > dateKey(); return `<tr><td><div class="entry-name"><span class="entry-icon ${t.type}" aria-hidden="true">${t.type === 'income' ? '↙' : '↗'}</span><span title="${escapeHtml(t.description)}">${escapeHtml(t.description)}</span></div></td><td><span class="category-pill">${escapeHtml(t.category)}</span></td><td>${parseDate(t.date).toLocaleDateString('pt-BR')}${scheduled ? ' <span class="scheduled-pill">Agendado</span>' : ''}</td><td class="amount-column ${t.type === 'income' ? 'income-amount' : ''}">${t.type === 'income' ? '+' : '−'} ${escapeHtml(money(t.amount))}</td><td class="row-actions"><button class="row-action" data-edit="${escapeHtml(t.id)}" aria-label="Editar ${escapeHtml(t.description)}" title="Editar">✎</button><button class="row-action" data-delete="${escapeHtml(t.id)}" aria-label="Excluir ${escapeHtml(t.description)}" title="Excluir">×</button></td></tr>`; }).join('');
  $('#transaction-count').textContent = `${items.length} ${items.length === 1 ? 'movimentação' : 'movimentações'}`;
  $('#empty-state').hidden = items.length > 0;
  $('#empty-state h3').textContent = state.transactions.length ? 'Nenhuma movimentação encontrada' : 'Aqui começa sua organização';
  $('#empty-state p').textContent = state.transactions.length ? 'Tente outra busca ou altere o filtro.' : 'Registre uma entrada ou saída para acompanhar seu dinheiro.';
}
function openDialog(id) { const dialog = $(id); dialog.querySelectorAll('.form-error').forEach(el => el.textContent = ''); dialog.showModal(); }
function transactionDialog(id) {
  const form = $('#transaction-form'); form.reset();
  form.elements.id.value = '';
  form.elements.date.min = state.startedOn; form.elements.date.max = addDays(dateKey(), MAX_SCHEDULE_DAYS); form.elements.date.value = dateKey();
  const transaction = state.transactions.find(t => t.id === id);
  if (transaction) {
    for (const field of ['id','type','description','category','date']) form.elements[field].value = transaction[field];
    form.elements.amount.value = (transaction.amount / 100).toFixed(2).replace('.', ',');
  }
  $('#transaction-title').textContent = transaction ? 'Editar movimentação' : 'Nova movimentação';
  updateDateHint(form.elements.date.value);
  openDialog('#transaction-dialog');
  form.elements.amount.focus();
}
function updateDateHint(date) {
  $('#transaction-date-hint').textContent = date > dateKey()
    ? 'Lançamento agendado. Ele não altera seu saldo disponível até a data escolhida; até lá, aparece como previsão da semana.'
    : 'Entradas redistribuem o saldo. Saídas reduzem a semana em que aconteceram.';
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
  const messages = {'auth/invalid-credential':'E-mail ou senha inválidos.','auth/invalid-email':'Informe um e-mail válido.','auth/user-not-found':'E-mail ou senha inválidos.','auth/wrong-password':'E-mail ou senha inválidos.','auth/email-already-in-use':'Este e-mail já tem uma conta. Selecione Entrar.','auth/weak-password':'Use uma senha com pelo menos 6 caracteres.','auth/operation-not-allowed':'O acesso por e-mail e senha ainda precisa ser habilitado no Firebase Authentication.','auth/configuration-not-found':'O acesso ainda precisa ser configurado no Firebase Authentication.','auth/unauthorized-domain':'O domínio deste site ainda precisa ser autorizado no Firebase Authentication.','auth/network-request-failed':'Não foi possível conectar. Verifique sua internet.','auth/too-many-requests':'Muitas tentativas. Aguarde um pouco e tente novamente.','permission-denied':'Não foi possível acessar seus dados. Confira as regras do Firestore no projeto Firebase.','unavailable':'Firebase indisponível. Tente novamente quando estiver conectado.'};
  return messages[error.code] || error.message || 'Não foi possível conectar ao Firebase.';
}
async function activateCloud(adapter) {
  const remote = await adapter.load();
  if (remote) validateState(remote);
  const accountState = remote || newState();
  if (!remote) await adapter.save(accountState);
  cloud = adapter; state = accountState;
  unsubscribeAuth?.();
  unsubscribeAuth = adapter.onSignedOut(showLogin);
  render();
  $('#login-screen').hidden = true;
  $('#app-sidebar').hidden = false;
  $('#overview').hidden = false;
  document.body.dataset.auth = 'authenticated';
  document.title = 'Semana · Seu dinheiro, no seu ritmo';
}
function showLogin() {
  unsubscribeAuth?.(); unsubscribeAuth = undefined;
  cloud = null; state = newState();
  filter = 'all'; $('#search').value = '';
  document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('selected', button.dataset.filter === 'all'));
  setLoginMode(false);
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('#app-sidebar').hidden = true; $('#overview').hidden = true;
  $('#login-screen').hidden = false;
  document.body.dataset.auth = 'signed-out';
  document.title = 'Entrar · Semana';
  $('#login-status').textContent = '';
  $('#login-form').elements.password.value = '';
  $('#transaction-form').reset(); $('#settings-form').reset();
  updateDateHint(dateKey());
  render();
}
function loginBusy(value) {
  $('#login-form').querySelectorAll('input,button').forEach(element => element.disabled = value);
  $('#login-toggle').disabled = value;
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
$('#transaction-form').elements.date.addEventListener('input', event => updateDateHint(event.target.value));
document.querySelectorAll('a.nav-link').forEach(link => link.onclick = () => document.querySelectorAll('a.nav-link').forEach(l => l.classList.toggle('active', l === link)));
$('#transaction-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const data = new FormData(form), id = data.get('id') || crypto.randomUUID();
    const entry = {id, type:data.get('type'), description:data.get('description').trim(), category:data.get('category'), date:data.get('date'), amount:parseMoney(data.get('amount'))};
    if (entry.date < state.startedOn || entry.date > addDays(dateKey(), MAX_SCHEDULE_DAYS)) throw new Error('A data deve estar entre o início do histórico e os próximos 10 anos.');
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
    download(state, `semana-antes-da-importacao-${dateKey()}.json`);
    await commit(imported);
    $('#settings-dialog').close(); toast('Backup restaurado.');
  } catch (error) { toast(error.message || 'Arquivo inválido.'); }
  finally { event.target.value = ''; }
};
$('#login-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  busy = true; loginBusy(true);
  form.querySelector('.form-error').textContent = '';
  $('#login-status').textContent = creatingAccount ? 'Criando sua conta…' : 'Entrando na sua conta…';
  try {
    const {connectCloud} = await import('./cloud.js');
    const adapter = await connectCloud({email:form.elements.email.value.trim(), password:form.elements.password.value, createAccount:creatingAccount});
    await activateCloud(adapter);
    form.elements.password.value = ''; $('#login-status').textContent = '';
  } catch (error) { $('#login-status').textContent = ''; form.querySelector('.form-error').textContent = friendlyError(error); }
  finally { busy = false; loginBusy(false); }
};
function setLoginMode(create) {
  creatingAccount = create;
  $('#login-heading').textContent = creatingAccount ? 'Vamos começar?' : 'Bom ter você por aqui.';
  $('#login-subtitle').textContent = creatingAccount ? 'Crie sua conta e dê o primeiro passo para se organizar.' : 'Entre na sua conta para organizar a próxima semana.';
  $('#login-submit').innerHTML = creatingAccount ? 'Criar minha conta <span aria-hidden="true">↗</span>' : 'Entrar na minha conta <span aria-hidden="true">↗</span>';
  $('#signup-prompt').textContent = creatingAccount ? 'Já tem uma conta?' : 'Ainda não tem uma conta?';
  $('#login-toggle').textContent = creatingAccount ? 'Entrar' : 'Criar conta';
  $('#login-form').elements.password.autocomplete = creatingAccount ? 'new-password' : 'current-password';
  $('#reset-password').hidden = creatingAccount;
  $('#login-form .form-error').textContent = ''; $('#login-status').textContent = '';
}
$('#login-toggle').onclick = () => setLoginMode(!creatingAccount);
$('#reset-password').onclick = async () => {
  const form = $('#login-form');
  if (!form.elements.email.reportValidity() || busy) return;
  busy = true; loginBusy(true);
  form.querySelector('.form-error').textContent = ''; $('#login-status').textContent = 'Solicitando recuperação de senha…';
  try {
    const {resetPassword} = await import('./cloud.js');
    await resetPassword(form.elements.email.value.trim());
    $('#login-status').textContent = 'Se houver uma conta com esse e-mail, você receberá as instruções para redefinir a senha.';
  } catch (error) { $('#login-status').textContent = ''; form.querySelector('.form-error').textContent = friendlyError(error); }
  finally { busy = false; loginBusy(false); }
};
$('#logout-button').onclick = async () => {
  if (busy) return toast('Aguarde o salvamento terminar.');
  busy = true; $('#logout-button').disabled = true;
  try {
    await cloud.disconnect(); showLogin();
  } catch (error) { toast(friendlyError(error)); }
  finally { busy = false; $('#logout-button').disabled = false; }
};
let lastDay = dateKey();
setInterval(() => { if (cloud && dateKey() !== lastDay) { lastDay = dateKey(); render(); } }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && cloud) render(); });
async function resumeCloud() {
  busy = true; loginBusy(true);
  try {
    const {connectCloud} = await import('./cloud.js');
    const adapter = await connectCloud();
    if (adapter) await activateCloud(adapter);
    else showLogin();
  } catch (error) { showLogin(); $('#login-form .form-error').textContent = friendlyError(error); }
  finally { busy = false; loginBusy(false); }
}
resumeCloud();
