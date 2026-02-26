/* ── Config ───────────────────────────────────────────────────────────────── */
const API = '';  // same origin
const SESSION_KEY = 'tester_session';
const ADMIN_KEY_STORE = 'tester_admin_key';
const RESULTS_KEY = 'tester_results';

/* ── State ────────────────────────────────────────────────────────────────── */
let currentTest = null;
let currentQuestions = [];
let currentQIndex = 0;
let userAnswers = {};         // { question_id: [answer_id, ...] }
let checkedResults = {};      // from API
let timerInterval = null;
let timerTotalLeft = 0;
let timerPerQLeft = 0;
let testStartTime = 0;
let adminKey = '';

/* ── Session ──────────────────────────────────────────────────────────────── */
function getSession() {
  let s = localStorage.getItem(SESSION_KEY);
  if (!s) { s = crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now(); localStorage.setItem(SESSION_KEY, s); }
  return s;
}

/* ── Router ───────────────────────────────────────────────────────────────── */
function navigate(page, data) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const p = document.getElementById('page-' + page);
  if (p) p.classList.add('active');
  const l = document.querySelector(`.nav-link[data-page="${page}"]`);
  if (l) l.classList.add('active');
  switch(page) {
    case 'home': loadHome(); break;
    case 'test': if (data) loadTest(data); break;
    case 'profile': loadProfile(); break;
    case 'admin': loadAdmin(); break;
  }
  window.scrollTo(0, 0);
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-page]');
  if (t) { e.preventDefault(); navigate(t.dataset.page); }
});

/* ── API helpers ──────────────────────────────────────────────────────────── */
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (adminKey) headers['X-Admin-Key'] = adminKey;
  const res = await fetch(API + path, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiUpload(path, formData) {
  const headers = {};
  if (adminKey) headers['X-Admin-Key'] = adminKey;
  const res = await fetch(API + path, { method: 'POST', headers, body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ── Toast ────────────────────────────────────────────────────────────────── */
function toast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  t.innerHTML = `<span style="color:${type==='success'?'var(--green)':type==='error'?'var(--red)':'var(--accent)'}">${icon}</span> ${msg}`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

/* ── Modal ────────────────────────────────────────────────────────────────── */
let modalSubmitFn = null;
function openModal(title, bodyHTML, submitLabel, onSubmit) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHTML;
  const overlay = document.getElementById('modalOverlay');
  overlay.classList.remove('hidden');
  modalSubmitFn = onSubmit;
  // Rebuild footer
  let footer = overlay.querySelector('.modal-footer');
  if (!footer) {
    footer = document.createElement('div');
    footer.className = 'modal-footer';
    document.getElementById('modal').appendChild(footer);
  }
  footer.innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary'; cancelBtn.textContent = 'Отмена';
  cancelBtn.onclick = closeModal;
  footer.appendChild(cancelBtn);
  if (submitLabel && onSubmit) {
    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn-primary'; submitBtn.textContent = submitLabel;
    submitBtn.id = 'modalSubmit';
    submitBtn.onclick = () => modalSubmitFn?.();
    footer.appendChild(submitBtn);
  }
}

function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
  modalSubmitFn = null;
}

document.getElementById('modalClose').onclick = closeModal;
document.getElementById('modalOverlay').addEventListener('click', e => {
  if (e.target.id === 'modalOverlay') closeModal();
});

/* ════════════════════════════════════════════════════════════════════════════
   HOME
═══════════════════════════════════════════════════════════════════════════ */
async function loadHome() {
  const grid = document.getElementById('testsGrid');
  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Загрузка…</span></div>';
  try {
    const tests = await apiFetch('/api/tests');
    renderTests(tests);
    document.getElementById('searchInput').oninput = e => {
      const q = e.target.value.toLowerCase();
      renderTests(tests.filter(t => t.title.toLowerCase().includes(q) || (t.description||'').toLowerCase().includes(q)));
    };
  } catch(e) {
    grid.innerHTML = `<div class="empty-state">Не удалось загрузить тесты: ${e.message}</div>`;
  }
}

function renderTests(tests) {
  const grid = document.getElementById('testsGrid');
  if (!tests.length) {
    grid.innerHTML = '<div class="empty-state">Тесты не найдены</div>'; return;
  }
  grid.innerHTML = tests.map(t => `
    <div class="test-card" data-id="${t.id}">
      <div class="test-card-title">${esc(t.title)}</div>
      ${t.description ? `<div class="test-card-desc">${esc(t.description)}</div>` : ''}
      <div class="test-card-meta">
        ${t.time_limit ? `<span>⏱ ${Math.floor(t.time_limit/60)} мин</span><span class="meta-dot"></span>` : ''}
        ${t.attempts != null ? `<span>${t.attempts} прохождений</span>` : ''}
        ${t.avg_score != null ? `<span class="meta-dot"></span><span>Ср. ${t.avg_score}%</span>` : ''}
      </div>
      <div class="test-card-footer">
        <button class="btn-start-card" data-id="${t.id}">Начать →</button>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', () => navigate('test', el.dataset.id));
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   TEST PREVIEW
═══════════════════════════════════════════════════════════════════════════ */
async function loadTest(testId) {
  showTestView('preview');
  document.getElementById('previewTitle').textContent = '…';

  try {
    const test = await apiFetch(`/api/tests/${testId}`);
    currentTest = test;
    currentQuestions = test.questions || [];

    document.getElementById('previewTitle').textContent = test.title;
    document.getElementById('previewDesc').textContent = test.description || '';

    const meta = document.getElementById('previewMeta');
    meta.innerHTML = [
      `<span class="preview-meta-item">📋 ${currentQuestions.length} вопросов</span>`,
      test.time_limit ? `<span class="preview-meta-item">⏱ Рекомендуемое время: ${Math.floor(test.time_limit/60)} мин</span>` : ''
    ].join('');

    if (test.time_limit) {
      document.getElementById('timerTotalVal').value = Math.round(test.time_limit / 60);
    }
  } catch(e) {
    toast('Ошибка загрузки теста: ' + e.message, 'error');
    navigate('home');
  }

  // Timer toggles
  ['timerTotal', 'timerPerQ'].forEach(id => {
    document.getElementById(id).onchange = function() {
      document.getElementById(id + 'Wrap').classList.toggle('hidden', !this.checked);
      if (id === 'timerTotal' && this.checked) document.getElementById('timerPerQ').checked = false, document.getElementById('timerPerQWrap').classList.add('hidden');
      if (id === 'timerPerQ' && this.checked) document.getElementById('timerTotal').checked = false, document.getElementById('timerTotalWrap').classList.add('hidden');
    };
  });

  document.getElementById('startTestBtn').onclick = startTest;
}

function showTestView(view) {
  ['testPreview', 'testSession', 'testResult'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById('test' + view.charAt(0).toUpperCase() + view.slice(1)).classList.remove('hidden');
}

/* ════════════════════════════════════════════════════════════════════════════
   TEST SESSION
═══════════════════════════════════════════════════════════════════════════ */
function startTest() {
  if (!currentQuestions.length) { toast('В тесте нет вопросов', 'error'); return; }

  userAnswers = {};
  currentQIndex = 0;
  testStartTime = Date.now();

  // Setup timers
  clearInterval(timerInterval);
  const useTotalTimer = document.getElementById('timerTotal').checked;
  const usePerQTimer = document.getElementById('timerPerQ').checked;
  timerTotalLeft = useTotalTimer ? parseInt(document.getElementById('timerTotalVal').value) * 60 : 0;
  timerPerQLeft = usePerQTimer ? parseInt(document.getElementById('timerPerQVal').value) : 0;

  const td = document.getElementById('timerDisplay');
  td.classList.toggle('hidden', !useTotalTimer && !usePerQTimer);

  if (useTotalTimer) {
    timerInterval = setInterval(() => {
      timerTotalLeft--;
      updateTimerDisplay(timerTotalLeft);
      if (timerTotalLeft <= 0) { clearInterval(timerInterval); finishTest(); }
    }, 1000);
  }

  showTestView('session');
  renderQuestion();

  document.getElementById('abortBtn').onclick = () => {
    if (confirm('Прервать тест?')) { clearInterval(timerInterval); navigate('home'); }
  };
}

function renderQuestion() {
  const q = currentQuestions[currentQIndex];
  const total = currentQuestions.length;

  document.getElementById('questionCounter').textContent = `${currentQIndex + 1} / ${total}`;
  document.getElementById('progressBar').style.width = `${((currentQIndex) / total) * 100}%`;

  const badge = document.getElementById('questionTypeBadge');
  badge.textContent = q.multiple ? 'Несколько вариантов' : 'Один вариант';

  document.getElementById('questionText').textContent = q.text;

  const img = document.getElementById('questionImage');
  if (q.image) { img.src = q.image; img.classList.remove('hidden'); }
  else { img.classList.add('hidden'); }

  // Remove feedback bar if any
  const old = document.getElementById('feedbackBar');
  if (old) old.remove();

  // Answers
  const list = document.getElementById('answersList');
  list.innerHTML = '';
  q.answers.forEach(a => {
    const item = document.createElement('div');
    item.className = 'answer-item';
    item.dataset.id = a.id;
    item.innerHTML = `
      <div class="answer-marker ${q.multiple ? 'checkbox-marker' : ''}"></div>
      <span class="answer-text">${esc(a.text)}</span>
      <span class="answer-feedback"></span>
    `;
    item.addEventListener('click', () => selectAnswer(q, a.id, item));
    list.appendChild(item);
  });

  const nextBtn = document.getElementById('nextBtn');
  nextBtn.classList.add('hidden');
  nextBtn.textContent = currentQIndex === total - 1 ? 'Завершить тест' : 'Далее →';
  nextBtn.onclick = advanceQuestion;

  // Per-question timer
  clearInterval(timerInterval);
  if (document.getElementById('timerPerQ').checked) {
    timerPerQLeft = parseInt(document.getElementById('timerPerQVal').value);
    const td = document.getElementById('timerDisplay');
    td.classList.remove('hidden');
    timerInterval = setInterval(() => {
      timerPerQLeft--;
      updateTimerDisplay(timerPerQLeft);
      if (timerPerQLeft <= 0) { clearInterval(timerInterval); autoAdvance(); }
    }, 1000);
  } else if (document.getElementById('timerTotal').checked) {
    // total timer continues, just update display
  }
}

function updateTimerDisplay(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  document.getElementById('timerValue').textContent = `${m}:${s.toString().padStart(2,'0')}`;
  document.getElementById('timerDisplay').classList.toggle('urgent', seconds <= 10);
}

function autoAdvance() {
  const q = currentQuestions[currentQIndex];
  if (!(q.id in userAnswers)) userAnswers[q.id] = [];
  revealAnswers(q, {});
  setTimeout(advanceQuestion, 1500);
}

function selectAnswer(q, answerId, itemEl) {
  if (itemEl.classList.contains('disabled')) return;
  const qid = q.id;
  const aid = String(answerId);

  if (q.multiple) {
    // Множественный выбор: toggleим, НЕ блокируем, показываем кнопку «Проверить»
    if (!userAnswers[qid]) userAnswers[qid] = [];
    const idx = userAnswers[qid].indexOf(aid);
    if (idx > -1) {
      userAnswers[qid].splice(idx, 1);
      itemEl.classList.remove('selected');
      itemEl.querySelector('.answer-marker').innerHTML = '';
    } else {
      userAnswers[qid].push(aid);
      itemEl.classList.add('selected');
      itemEl.querySelector('.answer-marker').innerHTML = '✓';
    }
    // Показываем «Проверить» если хоть что-то выбрано, иначе скрываем
    const nextBtn = document.getElementById('nextBtn');
    if (userAnswers[qid].length > 0) {
      nextBtn.classList.remove('hidden');
      nextBtn.textContent = 'Проверить ответ';
      nextBtn.onclick = () => confirmMultiple(q);
    } else {
      nextBtn.classList.add('hidden');
    }
  } else {
    // Одиночный: блокируем сразу после выбора
    userAnswers[qid] = [aid];
    document.querySelectorAll('.answer-item').forEach(i => {
      i.classList.remove('selected');
      i.querySelector('.answer-marker').innerHTML = '';
    });
    itemEl.classList.add('selected');
    itemEl.querySelector('.answer-marker').innerHTML = '●';
    document.querySelectorAll('.answer-item').forEach(i => i.classList.add('disabled'));
    if (document.getElementById('timerPerQ').checked) clearInterval(timerInterval);
    // Показываем «Далее» без немедленной проверки (проверка на сервере при финише)
    const nextBtn = document.getElementById('nextBtn');
    const isLast = currentQIndex === currentQuestions.length - 1;
    nextBtn.textContent = isLast ? 'Завершить тест' : 'Далее →';
    nextBtn.onclick = advanceQuestion;
    nextBtn.classList.remove('hidden');
  }
}

function confirmMultiple(q) {
  // Блокируем варианты и меняем кнопку на «Далее»
  document.querySelectorAll('.answer-item').forEach(i => i.classList.add('disabled'));
  if (document.getElementById('timerPerQ').checked) clearInterval(timerInterval);
  const nextBtn = document.getElementById('nextBtn');
  const isLast = currentQIndex === currentQuestions.length - 1;
  nextBtn.textContent = isLast ? 'Завершить тест' : 'Далее →';
  nextBtn.onclick = advanceQuestion;
}

function revealAnswers(q, qResult) {
  // qResult: { correct: bool, correct_ids: [...], submitted_ids: [...] }
  const items = document.querySelectorAll('.answer-item');
  items.forEach(item => {
    item.classList.add('disabled');
    const id = String(item.dataset.id);
    const isCorrect = qResult.correct_ids && qResult.correct_ids.includes(id);
    const isSubmitted = qResult.submitted_ids && qResult.submitted_ids.includes(id);
    const marker = item.querySelector('.answer-marker');
    const feedback = item.querySelector('.answer-feedback');

    if (isSubmitted && isCorrect) {
      item.classList.add('correct');
      marker.innerHTML = '✓'; feedback.textContent = '✓';
    } else if (isSubmitted && !isCorrect) {
      item.classList.add('wrong');
      marker.innerHTML = '✕'; feedback.textContent = '✗';
    } else if (!isSubmitted && isCorrect) {
      item.classList.add('missed');
      marker.innerHTML = ''; feedback.textContent = '✓';
    }
    item.classList.remove('selected');
  });

  // Feedback bar
  const old = document.getElementById('feedbackBar');
  if (old) old.remove();
  if (Object.keys(qResult).length) {
    const isCorrect = qResult.correct;
    const bar = document.createElement('div');
    bar.id = 'feedbackBar';
    bar.className = `feedback-bar ${isCorrect ? 'correct' : 'wrong'}`;
    bar.innerHTML = isCorrect ? '<span>✓</span> Правильно!' : '<span>✗</span> Неправильно. Правильный ответ выделен зелёным.';
    document.getElementById('answersList').after(bar);
  }
}

async function advanceQuestion() {
  const q = currentQuestions[currentQIndex];
  if (!userAnswers[q.id]) userAnswers[q.id] = [];

  if (currentQIndex === currentQuestions.length - 1) {
    // Last question → finish
    if (!document.getElementById('timerPerQ').checked) {
      // For multiple choice, we need to submit before revealing
    }
    await finishTest();
  } else {
    currentQIndex++;
    renderQuestion();
  }
}

async function finishTest() {
  clearInterval(timerInterval);
  const timeSpent = Math.round((Date.now() - testStartTime) / 1000);

  // Build answers payload
  const answersPayload = {};
  currentQuestions.forEach(q => {
    answersPayload[q.id] = userAnswers[q.id] || [];
  });

  try {
    const result = await apiFetch(`/api/tests/${currentTest.id}/check`, {
      method: 'POST',
      body: JSON.stringify({
        answers: answersPayload,
        session_id: getSession(),
        time_spent: timeSpent
      })
    });
    saveLocalResult(currentTest, result, timeSpent);
    showResult(result, timeSpent);
  } catch(e) {
    toast('Ошибка при отправке результатов: ' + e.message, 'error');
  }
}

function saveLocalResult(test, result, timeSpent) {
  const results = JSON.parse(localStorage.getItem(RESULTS_KEY) || '[]');
  results.unshift({
    test_id: test.id,
    title: test.title,
    score: result.score,
    total: result.total,
    percent: result.percent,
    time_spent: timeSpent,
    finished_at: new Date().toISOString()
  });
  localStorage.setItem(RESULTS_KEY, JSON.stringify(results.slice(0, 200)));
}

function showResult(result, timeSpent) {
  showTestView('result');

  const pct = result.percent;
  let icon, title, sub;
  if (pct >= 80) { icon = '🏆'; title = 'Отлично!'; sub = 'Вы отлично справились с тестом'; }
  else if (pct >= 50) { icon = '👍'; title = 'Неплохо!'; sub = 'Есть куда стремиться'; }
  else { icon = '📚'; title = 'Нужно повторить'; sub = 'Изучите материал и попробуйте снова'; }

  document.getElementById('resultIcon').textContent = icon;
  document.getElementById('resultTitle').textContent = title;
  document.getElementById('resultSubtitle').textContent = sub;

  const color = pct >= 80 ? 'green' : pct >= 50 ? 'accent' : 'red';
  document.getElementById('resultStats').innerHTML = `
    <div class="result-stat"><div class="result-stat-val ${color}">${pct}%</div><div class="result-stat-label">Результат</div></div>
    <div class="result-stat"><div class="result-stat-val green">${result.score}</div><div class="result-stat-label">Правильно</div></div>
    <div class="result-stat"><div class="result-stat-val red">${result.total - result.score}</div><div class="result-stat-label">Ошибок</div></div>
  `;

  const mins = Math.floor(timeSpent / 60), secs = timeSpent % 60;
  document.getElementById('resultDetail').innerHTML = `
    <div class="result-detail-item">
      <span class="result-detail-label">Вопросов</span>
      <span class="result-detail-val">${result.total}</span>
    </div>
    <div class="result-detail-item">
      <span class="result-detail-label">Затраченное время</span>
      <span class="result-detail-val">${mins}:${secs.toString().padStart(2,'0')}</span>
    </div>
    <div class="result-detail-item">
      <span class="result-detail-label">Тест</span>
      <span class="result-detail-val">${esc(currentTest.title)}</span>
    </div>
  `;

  document.getElementById('retryBtn').onclick = () => loadTest(currentTest.id);
}

/* ════════════════════════════════════════════════════════════════════════════
   PROFILE
═══════════════════════════════════════════════════════════════════════════ */
function loadProfile() {
  const results = JSON.parse(localStorage.getItem(RESULTS_KEY) || '[]');
  const el = document.getElementById('profileContent');

  if (!results.length) {
    el.innerHTML = '<div class="empty-state"><div>📋</div><span>Вы ещё не проходили тестов</span></div>';
    return;
  }

  // Group by test for chart
  const byTest = {};
  results.forEach(r => {
    if (!byTest[r.test_id]) byTest[r.test_id] = { title: r.title, results: [] };
    byTest[r.test_id].results.push(r);
  });

  let html = `
    <div class="results-table">
      <div class="results-table-header">
        <span>Тест</span><span>Дата</span><span>Результат</span><span>Время</span>
      </div>
      ${results.slice(0, 50).map(r => {
        const d = new Date(r.finished_at);
        const dateStr = `${d.getDate().toString().padStart(2,'0')}.${(d.getMonth()+1).toString().padStart(2,'0')}.${d.getFullYear()}`;
        const mins = Math.floor(r.time_spent/60), secs = r.time_spent%60;
        const cls = r.percent >= 80 ? 'high' : r.percent >= 50 ? 'mid' : 'low';
        return `
          <div class="results-table-row">
            <span>${esc(r.title)}</span>
            <span style="color:var(--text-2);font-size:13px">${dateStr}</span>
            <span class="result-percent ${cls}">${r.percent}%</span>
            <span style="font-family:var(--font-mono);font-size:13px">${mins}:${secs.toString().padStart(2,'0')}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Chart per test
  html += '<div class="chart-wrap"><h3>Прогресс по тестам</h3>';
  Object.values(byTest).forEach(td => {
    const last10 = td.results.slice(0, 10).reverse();
    const max = Math.max(...last10.map(r => r.percent), 1);
    html += `
      <div style="margin-bottom:24px">
        <div style="font-size:13px;color:var(--text-2);margin-bottom:8px">${esc(td.title)}</div>
        <div class="mini-chart">
          ${last10.map(r => `
            <div class="mini-bar" style="height:${(r.percent/100)*100}%">
              <div class="mini-bar-tip">${r.percent}%</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  });
  html += '</div>';

  el.innerHTML = html;
}

/* ════════════════════════════════════════════════════════════════════════════
   ADMIN
═══════════════════════════════════════════════════════════════════════════ */
function loadAdmin() {
  const savedKey = sessionStorage.getItem(ADMIN_KEY_STORE);
  if (savedKey) { adminKey = savedKey; showAdminPanel(); }
  else { document.getElementById('adminLogin').classList.remove('hidden'); document.getElementById('adminPanel').classList.add('hidden'); }
}

document.getElementById('adminLoginBtn').onclick = async () => {
  const key = document.getElementById('adminKeyInput').value.trim();
  if (!key) return;
  adminKey = key;
  try {
    await apiFetch('/api/admin/verify', { method: 'POST', body: JSON.stringify({ key }) });
    sessionStorage.setItem(ADMIN_KEY_STORE, key);
    document.getElementById('loginError').classList.add('hidden');
    showAdminPanel();
    document.getElementById('adminNavLink').classList.remove('hidden');
  } catch {
    document.getElementById('loginError').classList.remove('hidden');
    adminKey = '';
  }
};
document.getElementById('adminKeyInput').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('adminLoginBtn').click(); });

document.getElementById('adminLogoutBtn').onclick = () => {
  sessionStorage.removeItem(ADMIN_KEY_STORE);
  adminKey = '';
  document.getElementById('adminNavLink').classList.add('hidden');
  document.getElementById('adminPanel').classList.add('hidden');
  document.getElementById('adminLogin').classList.remove('hidden');
};

async function showAdminPanel() {
  document.getElementById('adminLogin').classList.add('hidden');
  document.getElementById('adminPanel').classList.remove('hidden');
  document.getElementById('adminNavLink').classList.remove('hidden');
  await loadAdminTests();
}

async function loadAdminTests() {
  const el = document.getElementById('adminTestsList');
  el.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Загрузка…</span></div>';
  try {
    const tests = await apiFetch('/api/admin/tests');
    if (!tests.length) { el.innerHTML = '<div class="empty-state">Тестов пока нет</div>'; return; }
    el.innerHTML = '<div class="admin-tests-grid">' + tests.map(t => `
      <div class="admin-test-row">
        <div class="admin-test-info">
          <div class="admin-test-title">${esc(t.title)}</div>
          <div class="admin-test-meta">
            ${t.attempts || 0} прохождений · Ср. ${t.avg_score || 0}%
            ${t.time_limit ? ` · ⏱ ${Math.floor(t.time_limit/60)} мин` : ''}
          </div>
        </div>
        <span class="status-badge ${t.active ? 'active' : 'inactive'}" id="badge-${t.id}">
          ${t.active ? 'Активен' : 'Скрыт'}
        </span>
        <div class="admin-test-actions">
          <button class="btn-ghost" onclick="editTest(${t.id})">Изменить</button>
          <button class="btn-ghost" onclick="toggleTest(${t.id}, this)">
            ${t.active ? 'Скрыть' : 'Показать'}
          </button>
          <button class="btn-danger" onclick="deleteTest(${t.id}, this)">Удалить</button>
        </div>
      </div>
    `).join('') + '</div>';
  } catch(e) {
    el.innerHTML = `<div class="empty-state">Ошибка: ${e.message}</div>`;
  }
}

async function toggleTest(id, btn) {
  try {
    const res = await apiFetch(`/api/admin/tests/${id}/toggle`, { method: 'POST', body: JSON.stringify({}) });
    const badge = document.getElementById(`badge-${id}`);
    if (badge) { badge.textContent = res.active ? 'Активен' : 'Скрыт'; badge.className = `status-badge ${res.active ? 'active' : 'inactive'}`; }
    btn.textContent = res.active ? 'Скрыть' : 'Показать';
    toast(res.active ? 'Тест опубликован' : 'Тест скрыт', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteTest(id, btn) {
  if (!confirm('Удалить тест? Это действие необратимо.')) return;
  try {
    await apiFetch(`/api/admin/tests/${id}`, { method: 'DELETE', body: JSON.stringify({}) });
    toast('Тест удалён', 'success');
    await loadAdminTests();
  } catch(e) { toast(e.message, 'error'); }
}

/* ── Test Editor ──────────────────────────────────────────────────────────── */
document.getElementById('newTestBtn').onclick = () => openTestEditor(null);

async function editTest(id) {
  try {
    const test = await apiFetch(`/api/admin/tests/${id}`);
    openTestEditor(test);
  } catch(e) { toast(e.message, 'error'); }
}

function openTestEditor(test) {
  const isNew = !test;
  const t = test || { title: '', description: '', time_limit: 0, time_per_question: 0, active: 1, questions: [] };

  const bodyHTML = `
    <div class="form-group">
      <label class="form-label">Название теста *</label>
      <input class="form-input" id="ef_title" value="${esc(t.title)}" placeholder="Например: История России" />
    </div>
    <div class="form-group">
      <label class="form-label">Описание</label>
      <textarea class="form-input" id="ef_desc" placeholder="Краткое описание (необязательно)">${esc(t.description||'')}</textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Таймер на тест (мин, 0 = нет)</label>
        <input class="form-input" id="ef_time_limit" type="number" min="0" value="${Math.floor((t.time_limit||0)/60)}" />
      </div>
      <div class="form-group">
        <label class="form-label">Таймер на вопрос (сек, 0 = нет)</label>
        <input class="form-input" id="ef_time_per_q" type="number" min="0" value="${t.time_per_question||0}" />
      </div>
    </div>
    <div class="divider"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <strong style="font-size:15px">Вопросы</strong>
      <button class="btn-ghost" onclick="addQuestion()">+ Добавить вопрос</button>
    </div>
    <div id="questionsEditor">${t.questions.map((q, i) => buildQuestionEditor(q, i)).join('')}</div>
    <button class="btn-ghost" style="width:100%;justify-content:center;margin-top:8px" onclick="addQuestion()">+ Добавить вопрос</button>
  `;

  openModal(isNew ? 'Новый тест' : 'Редактировать тест', bodyHTML, isNew ? 'Создать' : 'Сохранить', async () => {
    await saveTest(test?.id);
  });
}

function buildQuestionEditor(q, idx) {
  const qid = q?.id || `new_${Date.now()}_${idx}`;
  const answers = q?.answers || [{text:'',correct:false},{text:'',correct:false}];
  return `
    <div class="question-editor" id="qe_${qid}" data-qid="${qid}">
      <div class="question-editor-header">
        <span class="question-num">Вопрос ${idx+1}</span>
        <button class="btn-danger" style="padding:4px 10px;font-size:12px" onclick="removeQuestion('${qid}')">Удалить</button>
      </div>
      <div class="form-group">
        <input class="form-input qe-text" value="${esc(q?.text||'')}" placeholder="Текст вопроса" />
      </div>
      <div class="multiple-toggle">
        <input type="checkbox" class="answer-correct-cb qe-multiple" id="mult_${qid}" ${q?.multiple ? 'checked' : ''} />
        <label for="mult_${qid}">Несколько правильных ответов</label>
      </div>
      <div class="qe-answers">
        ${answers.map((a, ai) => buildAnswerEditor(a, ai)).join('')}
      </div>
      <button class="btn-add-answer" onclick="addAnswer(this)">+ Добавить вариант</button>
    </div>
  `;
}

function buildAnswerEditor(a, idx) {
  return `
    <div class="answer-editor">
      <input type="checkbox" class="answer-correct-cb ae-correct" title="Правильный ответ" ${a?.correct ? 'checked':''} />
      <input class="form-input ae-text" value="${esc(a?.text||'')}" placeholder="Вариант ответа ${idx+1}" />
      <button class="btn-remove-answer" onclick="this.closest('.answer-editor').remove()" title="Удалить">×</button>
    </div>
  `;
}

function addQuestion() {
  const container = document.getElementById('questionsEditor');
  const idx = container.querySelectorAll('.question-editor').length;
  const div = document.createElement('div');
  div.innerHTML = buildQuestionEditor(null, idx);
  container.appendChild(div.firstElementChild);
  renumberQuestions();
}

function removeQuestion(qid) {
  document.getElementById('qe_' + qid)?.remove();
  renumberQuestions();
}

function addAnswer(btn) {
  const answersDiv = btn.previousElementSibling;
  const div = document.createElement('div');
  div.innerHTML = buildAnswerEditor(null, answersDiv.children.length);
  answersDiv.appendChild(div.firstElementChild);
}

function renumberQuestions() {
  document.querySelectorAll('.question-editor').forEach((el, i) => {
    const num = el.querySelector('.question-num');
    if (num) num.textContent = `Вопрос ${i+1}`;
  });
}

async function saveTest(testId) {
  const title = document.getElementById('ef_title').value.trim();
  if (!title) { toast('Введите название', 'error'); return; }

  const questions = [];
  document.querySelectorAll('.question-editor').forEach(qEl => {
    const text = qEl.querySelector('.qe-text').value.trim();
    if (!text) return;
    const multiple = qEl.querySelector('.qe-multiple').checked;
    const answers = [];
    qEl.querySelectorAll('.answer-editor').forEach(aEl => {
      const aText = aEl.querySelector('.ae-text').value.trim();
      const correct = aEl.querySelector('.ae-correct').checked;
      if (aText) answers.push({ text: aText, correct });
    });
    questions.push({ text, multiple, answers });
  });

  const payload = {
    title,
    description: document.getElementById('ef_desc').value.trim(),
    time_limit: parseInt(document.getElementById('ef_time_limit').value || '0') * 60,
    time_per_question: parseInt(document.getElementById('ef_time_per_q').value || '0'),
    active: 1,
    questions
  };

  try {
    const submitBtn = document.getElementById('modalSubmit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Сохранение…'; }
    if (testId) {
      await apiFetch(`/api/admin/tests/${testId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Тест обновлён', 'success');
    } else {
      await apiFetch('/api/admin/tests', { method: 'POST', body: JSON.stringify(payload) });
      toast('Тест создан', 'success');
    }
    closeModal();
    await loadAdminTests();
  } catch(e) { toast(e.message, 'error'); }
}

/* ── Import ───────────────────────────────────────────────────────────────── */
document.getElementById('importBtn').onclick = openImportModal;

function openImportModal() {
  const bodyHTML = `
    <p style="color:var(--text-2);font-size:14px;margin-bottom:16px">
      Загрузите файл теста в формате JSON или CSV
    </p>
    <div class="file-drop" id="fileDrop">
      <div style="font-size:32px">📁</div>
      <p>Перетащите файл или <span>нажмите для выбора</span></p>
      <input type="file" id="fileInput" accept=".json,.csv" style="display:none" />
    </div>
    <div style="margin-top:16px">
      <div style="font-size:13px;color:var(--text-2);margin-bottom:8px">Формат CSV:</div>
      <div class="format-hint">test_title,test_description,question_text,answer_text,correct,multiple
История России,Тест по истории,Первый император?,Пётр I,true,false
История России,Тест по истории,Первый император?,Иван IV,false,false</div>
    </div>
  `;
  openModal('Импорт теста', bodyHTML, 'Загрузить', handleImport);

  setTimeout(() => {
    const drop = document.getElementById('fileDrop');
    const inp = document.getElementById('fileInput');
    drop.onclick = () => inp.click();
    inp.onchange = () => drop.querySelector('p').innerHTML = `<span>${inp.files[0]?.name}</span>`;
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('drag-over'); };
    drop.ondragleave = () => drop.classList.remove('drag-over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('drag-over'); inp.files = e.dataTransfer.files; drop.querySelector('p').innerHTML = `<span>${inp.files[0]?.name}</span>`; };
  }, 50);
}

async function handleImport() {
  const inp = document.getElementById('fileInput');
  if (!inp?.files?.[0]) { toast('Выберите файл', 'error'); return; }
  const formData = new FormData();
  formData.append('file', inp.files[0]);
  try {
    const res = await apiUpload('/api/admin/import', formData);
    toast(`Импортировано тестов: ${res.created?.length || 0}`, 'success');
    closeModal();
    await loadAdminTests();
  } catch(e) { toast(e.message, 'error'); }
}

/* ── Util ─────────────────────────────────────────────────────────────────── */
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Init ─────────────────────────────────────────────────────────────────── */
navigate('home');
if (sessionStorage.getItem(ADMIN_KEY_STORE)) {
  adminKey = sessionStorage.getItem(ADMIN_KEY_STORE);
  document.getElementById('adminNavLink').classList.remove('hidden');
}
