import {calculate, prepareReservations, dateKey, parseDate, addDays, nextPayday, newState, validateState, MAX_CENTS, MAX_SCHEDULE_DAYS} from './budget.js';

const $ = selector => document.querySelector(selector);
const money = cents => (cents / 100).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
const shortDate = key => { const date = parseDate(key); return `${String(date.getDate()).padStart(2, '0')} ${date.toLocaleDateString('pt-BR', {month:'short'}).replace('.', '')}`; };
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const daysBetween = (from, to) => Math.round((parseDate(to) - parseDate(from)) / 86400000);
const PAGE_SIZE = 30;
let cloud = null, filter = 'all', visibleCount = PAGE_SIZE, busy = false, toastTimer, unsubscribeAuth;
let state = newState(), creatingAccount = false;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4000);
}
function setStatus(message, error = false) {
  $('#sync-label').textContent = message;
  $('.sync').classList.toggle('error', error);
}
function parseMoney(value, allowNegative = false) {
  const text = value.trim().replace(/\s/g, '');
  if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text)) throw new Error('Use um valor como 50,00 ou 1.250,50.');
  const cents = Math.round(Number(text.replaceAll('.', '').replace(',', '.')) * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS || (!allowNegative && cents <= 0)) throw new Error('Informe um valor válido maior que zero.');
  return cents;
}
const formatCents = cents => (cents / 100).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
// Máscara de valor: os dígitos digitados entram pela direita como centavos (5 → 0,05 → 0,50 → 5,00 → 50,00 …).
function maskMoneyInput(input) {
  const digits = input.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, String(MAX_CENTS).length);
  input.value = digits ? formatCents(Math.min(Number(digits), MAX_CENTS)) : '';
  input.setSelectionRange(input.value.length, input.value.length);
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
    setStatus('Salvando…');
    await adapter.save(next);
    if (cloud !== adapter) throw new Error('Sua sessão foi encerrada. Entre novamente.');
    state = next; render();
  } catch (error) {
    setStatus('Falha ao salvar', true);
    throw new Error(error.code ? friendlyError(error) : error.message || 'Não foi possível salvar.');
  } finally { busy = false; }
}
function render() {
  const today = dateKey(), budget = calculate(state, today);
  const [current, ...upcoming] = budget.periods;
  const week = current || {amount:0, end:today};
  $('#week-available').textContent = money(week.amount);
  $('#week-available').classList.toggle('negative', week.amount < 0);
  $('#hero-label').textContent = week.amount < 0 ? 'Passou do limite desta semana' : 'Pode gastar esta semana';
  const left = daysBetween(today, week.end) + 1;
  $('#week-range').textContent = `Até ${parseDate(week.end).toLocaleDateString('pt-BR', {weekday:'long'})}, ${shortDate(week.end)} · ${left === 1 ? 'último dia' : `${left} dias`}`;
  $('#total-balance').textContent = money(budget.total);
  $('#reserved-balance').textContent = money(budget.reserved);
  const toPayday = daysBetween(today, budget.payday);
  $('#payday-label').textContent = shortDate(budget.payday);
  $('#payday-in').textContent = toPayday === 1 ? 'Recebe amanhã' : `Recebe em ${toPayday} dias`;
  $('#reservation-warning').hidden = budget.shortfall === 0;
  $('#reservation-warning').textContent = budget.shortfall ? `Faltam ${money(budget.shortfall)} para cobrir as contas até o próximo recebimento.` : '';
  const month = parseDate(today).toLocaleDateString('pt-BR', {month:'long'});
  document.querySelectorAll('.current-month').forEach(el => el.textContent = month);
  $('#month-income').textContent = money(budget.income);
  $('#month-expense').textContent = money(budget.expense);
  $('#welcome-strip').hidden = state.initialized;
  $('#weeks').closest('.block').hidden = upcoming.length === 0;
  $('#weeks').innerHTML = upcoming.map(period => {
    const planned = state.transactions.filter(t => t.date > today && t.date >= period.start && t.date <= period.end).length;
    return `<li><span class="w-name">${escapeHtml(shortDate(period.start))} – ${escapeHtml(shortDate(period.end))}${planned ? `<span class="w-tag">${planned} agendado${planned === 1 ? '' : 's'}</span>` : ''}</span><span class="w-amount ${period.amount < 0 ? 'negative' : ''}">${escapeHtml(money(period.amount))}</span></li>`;
  }).join('');
  setStatus(cloud ? 'Salvo' : 'Desconectado');
  $('#account-label').textContent = cloud ? `Conectado como ${cloud.email}` : '';
  renderTransactions();
}
const RECENT_COUNT = 3;
const normalize = text => text.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ]/g, '');
const sortedTransactions = () => state.transactions.map((t, index) => ({...t, index})).sort((a, b) => b.date.localeCompare(a.date) || b.index - a.index);
function entryHtml(t, today) {
  const income = t.type === 'income';
  return `<li><button class="entry" data-edit="${escapeHtml(t.id)}" aria-label="Editar ${escapeHtml(t.description)}"><span class="entry-icon ${t.type}" aria-hidden="true">${income ? '+' : '−'}</span><span class="entry-text"><strong>${escapeHtml(t.description)}</strong><span>${escapeHtml(t.category)} · ${escapeHtml(shortDate(t.date))}${t.fixed ? '<span class="tag">fixo</span>' : ''}${t.date > today ? '<span class="tag">agendado</span>' : ''}</span></span><span class="entry-amount ${t.type}">${income ? '+' : '−'} ${escapeHtml(money(t.amount))}</span></button></li>`;
}
function renderTransactions() {
  const today = dateKey(), all = sortedTransactions();
  // Tela inicial: só os últimos lançamentos.
  $('#recent-rows').innerHTML = all.slice(0, RECENT_COUNT).map(t => entryHtml(t, today)).join('');
  $('#recent-empty').hidden = all.length > 0;
  $('#see-all').hidden = all.length === 0;
  // Página de lançamentos: busca + filtro, agrupado por mês.
  const search = normalize($('#search').value.trim());
  const items = all.filter(t => (filter === 'all' || filter === t.type) && (!search || normalize(`${t.description} ${t.category}`).includes(search)));
  const shown = items.slice(0, visibleCount), groups = new Map();
  for (const t of shown) { const key = t.date.slice(0, 7); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(t); }
  const sumOf = list => list.reduce((acc, t) => { acc[t.type] += t.amount; return acc; }, {income:0, expense:0});
  const year = parseDate(today).getFullYear();
  $('#transaction-rows').innerHTML = [...groups].map(([key, list]) => {
    const first = parseDate(`${key}-01`), sums = sumOf(items.filter(t => t.date.startsWith(key)));
    const title = first.toLocaleDateString('pt-BR', {month:'long', ...(first.getFullYear() !== year ? {year:'numeric'} : {})});
    const totals = [sums.income ? `+ ${money(sums.income)}` : '', sums.expense ? `− ${money(sums.expense)}` : ''].filter(Boolean).join(' · ');
    return `<section class="group"><div class="group-head"><h2>${escapeHtml(title)}</h2><span>${escapeHtml(totals)}</span></div><ul class="entries">${list.map(t => entryHtml(t, today)).join('')}</ul></section>`;
  }).join('');
  const filtered = search || filter !== 'all';
  const sums = sumOf(items);
  $('#result-sum').textContent = filtered && items.length ? `${items.length} ${items.length === 1 ? 'lançamento' : 'lançamentos'}${sums.expense ? ` · gastos ${money(sums.expense)}` : ''}${sums.income ? ` · ganhos ${money(sums.income)}` : ''}` : '';
  $('#show-more').hidden = items.length <= visibleCount;
  $('#empty-state').hidden = items.length > 0;
  $('#empty-state').textContent = !state.transactions.length ? 'Nenhum lançamento ainda.' : search ? `Nada encontrado para “${$('#search').value.trim()}”.` : 'Nada neste filtro.';
}
// Navegação: tela inicial ↔ página de lançamentos (#lancamentos), com o botão voltar do celular funcionando.
let openedFromHome = false;
function showView() {
  const onHistory = location.hash === '#lancamentos';
  $('#home-view').hidden = onHistory;
  $('#history-view').hidden = !onHistory;
  window.scrollTo({top:0});
}
function resetHistoryFilters() {
  filter = 'all'; visibleCount = PAGE_SIZE; $('#search').value = '';
  document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('selected', button.dataset.filter === 'all'));
}
function openDialog(id) { const dialog = $(id); dialog.querySelectorAll('.form-error').forEach(el => el.textContent = ''); dialog.showModal(); }
function updateTransactionTitle() {
  const form = $('#transaction-form');
  $('#fixed-field').hidden = form.elements.type.value !== 'expense';
  $('#transaction-title').textContent = form.elements.id.value ? 'Editar lançamento' : form.elements.type.value === 'income' ? 'Novo ganho' : 'Novo gasto';
}
function transactionDialog(id, type) {
  const form = $('#transaction-form'); form.reset();
  form.elements.id.value = '';
  if (type) form.elements.type.value = type;
  form.elements.date.min = state.startedOn; form.elements.date.max = addDays(dateKey(), MAX_SCHEDULE_DAYS); form.elements.date.value = dateKey();
  const transaction = state.transactions.find(t => t.id === id);
  if (transaction) {
    for (const field of ['id','type','description','category','date']) form.elements[field].value = transaction[field];
    form.elements.amount.value = formatCents(transaction.amount);
  } else if (form.elements.type.value === 'income') form.elements.category.value = 'Salário';
  form.elements.fixed.checked = Boolean(transaction?.fixed);
  $('#delete-transaction').hidden = !transaction;
  updateTransactionTitle();
  updateDateHint(form.elements.date.value);
  openDialog('#transaction-dialog');
  form.elements.amount.focus();
}
function updateDateHint(date) {
  $('#transaction-date-hint').textContent = date > dateKey()
    ? ($('#transaction-form').elements.type.value === 'expense'
      ? (date < nextPayday(dateKey(), state.paydayOverrides)
        ? 'Agendado: já fica reservado e sai do saldo na data.'
        : 'Agendado: será reservado no ciclo do vencimento.')
      : 'Agendado: entra no saldo na data escolhida.')
    : '';
}
function fillSettings() {
  const form = $('#settings-form');
  form.elements.balance.value = formatCents(state.initialBalance);
  form.elements.payday.value = nextPayday(dateKey(), state.paydayOverrides);
  form.elements.payday.min = addDays(dateKey(), 1);
  const next = parseDate(nextPayday(dateKey()));
  form.elements.payday.max = dateKey(new Date(next.getFullYear(), next.getMonth() + 1, 0, 12));
  $('#balance-hint').textContent = `Quanto você tinha em ${parseDate(state.startedOn).toLocaleDateString('pt-BR')}. Mudar recalcula tudo.`;
}
function openSettings() { fillSettings(); openDialog('#settings-dialog'); }
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
  const loadedState = remote || newState();
  const accountState = prepareReservations(loadedState);
  if (!remote || accountState !== loadedState) await adapter.save(accountState);
  cloud = adapter; state = accountState;
  unsubscribeAuth?.();
  unsubscribeAuth = adapter.onSignedOut(showLogin);
  if (location.hash && location.hash !== '#lancamentos') history.replaceState(null, '', location.pathname + location.search);
  render(); showView();
  $('#login-screen').hidden = true;
  $('#overview').hidden = false;
  document.body.dataset.auth = 'authenticated';
  document.title = 'Semana';
}
function showLogin() {
  unsubscribeAuth?.(); unsubscribeAuth = undefined;
  cloud = null; state = newState();
  resetHistoryFilters();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  showView();
  setLoginMode(false);
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('#overview').hidden = true;
  $('#login-screen').hidden = false;
  document.body.dataset.auth = 'signed-out';
  document.title = 'Entrar · Semana';
  $('#login-status').textContent = '';
  $('#login-form').elements.password.value = '';
  $('#transaction-form').reset(); $('#settings-form').reset();
  render();
}
function loginBusy(value) {
  $('#login-form').querySelectorAll('input,button').forEach(element => element.disabled = value);
  $('#login-toggle').disabled = value; $('#reset-password').disabled = value;
}
document.querySelectorAll('[data-quick-type]').forEach(button => button.onclick = () => transactionDialog(undefined, button.dataset.quickType));
$('#welcome-strip').onclick = openSettings;
$('#settings-button').onclick = openSettings;
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));
document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => {
  filter = button.dataset.filter; visibleCount = PAGE_SIZE;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b === button)); renderTransactions();
});
$('#show-more').onclick = () => { visibleCount += PAGE_SIZE; renderTransactions(); };
$('#search').addEventListener('input', () => { visibleCount = PAGE_SIZE; renderTransactions(); });
$('#see-all').onclick = event => { event.preventDefault(); resetHistoryFilters(); renderTransactions(); openedFromHome = true; history.pushState(null, '', '#lancamentos'); showView(); };
$('#back-button').onclick = event => {
  event.preventDefault();
  if (openedFromHome) history.back();
  else { history.replaceState(null, '', location.pathname + location.search); showView(); }
};
window.addEventListener('popstate', () => { openedFromHome = false; showView(); });
window.addEventListener('hashchange', showView);
$('#transaction-form').elements.amount.addEventListener('input', event => maskMoneyInput(event.target));
$('#transaction-form').elements.date.addEventListener('input', event => updateDateHint(event.target.value));
$('#transaction-form').addEventListener('change', event => {
  if (event.target.name !== 'type') return;
  const form = event.currentTarget;
  if (!form.elements.id.value) form.elements.category.value = form.elements.type.value === 'income' ? 'Salário' : 'Alimentação';
  updateTransactionTitle(); updateDateHint(form.elements.date.value);
});
$('#transaction-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const data = new FormData(form), id = data.get('id') || crypto.randomUUID();
    const entry = {id, type:data.get('type'), description:data.get('description').trim(), category:data.get('category'), date:data.get('date'), amount:parseMoney(data.get('amount'))};
    if (entry.date < state.startedOn || entry.date > addDays(dateKey(), MAX_SCHEDULE_DAYS)) throw new Error('A data deve estar entre o início do histórico e os próximos 10 anos.');
    const next = structuredClone(state), existing = next.transactions.findIndex(t => t.id === id);
    const previous = existing >= 0 ? next.transactions[existing] : null;
    if (entry.type === 'expense') {
      if (data.get('fixed')) entry.fixed = true;
      if (previous?.reservedFrom && previous.reservedFrom < entry.date) entry.reservedFrom = previous.reservedFrom;
      else if (entry.date > dateKey()) entry.reservedFrom = dateKey();
    }
    if (existing >= 0) next.transactions[existing] = entry; else next.transactions.push(entry);
    next.initialized = true;
    await commit(next); $('#transaction-dialog').close(); toast(entry.type === 'income' ? 'Ganho salvo.' : entry.fixed ? 'Gasto fixo salvo e dividido entre as semanas.' : 'Gasto salvo.');
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#delete-transaction').onclick = async () => {
  const id = $('#transaction-form').elements.id.value;
  if (!id || !await askConfirmation('Excluir lançamento?', 'Ele será removido e o saldo recalculado.')) return;
  try {
    const next = structuredClone(state); next.transactions = next.transactions.filter(t => t.id !== id);
    await commit(next); $('#transaction-dialog').close(); toast('Lançamento excluído.');
  } catch (error) { $('#transaction-form .form-error').textContent = error.message; }
};
$('#overview').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit]');
  if (edit) transactionDialog(edit.dataset.edit);
});
$('#settings-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const balance = parseMoney(form.elements.balance.value, true), payday = form.elements.payday.value;
    parseDate(payday);
    if (payday <= dateKey() || payday > form.elements.payday.max) throw new Error('Escolha uma data futura até o final do mês de recebimento.');
    if (state.initialized && balance !== state.initialBalance && !await askConfirmation('Alterar saldo inicial?', 'O saldo e todas as semanas serão recalculados desde o início.')) return;
    const next = structuredClone(state); next.initialBalance = balance; next.initialized = true;
    for (const [month, date] of Object.entries(next.paydayOverrides)) if (date > dateKey()) delete next.paydayOverrides[month];
    next.paydayOverrides[payday.slice(0, 7)] = payday;
    await commit(next); $('#settings-dialog').close(); toast('Ajustes salvos.');
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#export-button').onclick = () => { download(state); toast('Backup exportado.'); };
$('#import-input').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('O arquivo deve ter no máximo 5 MB.');
    const imported = prepareReservations(validateState(JSON.parse(await file.text())));
    if (!await askConfirmation('Restaurar backup?', 'Os dados atuais serão exportados como backup e substituídos pelos dados deste arquivo.')) return;
    download(state, `semana-antes-da-importacao-${dateKey()}.json`);
    await commit(imported);
    fillSettings(); toast('Backup restaurado.');
  } catch (error) { toast(error.message || 'Arquivo inválido.'); }
  finally { event.target.value = ''; }
};
$('#login-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  busy = true; loginBusy(true);
  form.querySelector('.form-error').textContent = '';
  $('#login-status').textContent = creatingAccount ? 'Criando sua conta…' : 'Entrando…';
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
  $('#login-heading').textContent = creatingAccount ? 'Criar conta' : 'Entrar';
  $('#login-submit').textContent = creatingAccount ? 'Criar conta' : 'Entrar';
  $('#login-toggle').textContent = creatingAccount ? 'Já tenho conta' : 'Criar conta';
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
