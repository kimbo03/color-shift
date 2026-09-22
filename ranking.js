/* ============================================================
   COLOR SHIFT SHOOTER — 랭킹 시스템
   ------------------------------------------------------------
   · 첫 방문 시 닉네임 · 반 · 학번 · 이름을 입력받는다
   · 게임(iframe)이 끝나면 점수와 도달 스테이지를 받아 최고 기록만 남긴다
   · 개인 순위(상위 30명) / 반별 순위(상위 10반)를 보여준다
     내 기록이 그 아래면 ⋯ 뒤에 내 줄을 따로 붙인다

   읽기 비용을 아끼려고 이렇게 했다 (Firebase 무료 한도: 하루 5만 읽기)
   · 순위표는 상위 N개만 읽는다 — 컬렉션 전체를 훑지 않는다
   · 반별 합계는 기록을 쓸 때 `반 문서`에 같이 누적해 둔다 (반 개수만큼만 읽으면 된다)
   · 순위표가 화면에 보일 때만 불러오고, 3분간 캐시한다
   · 기록을 낸 직후에는 순위표를 다시 읽지 않는다 (화면에 보일 때만 갱신)

   Firebase 설정값이 비어 있으면 이 브라우저 안에서만 저장되는
   로컬 모드로 동작한다 (설정값을 채우면 그대로 실서버 랭킹이 된다).
   ============================================================ */
(function () {
'use strict';

/* ------------------------------------------------------------
   0. 설정
   ------------------------------------------------------------ */
const CFG           = window.FIREBASE_CONFIG || {};
const COLL          = window.RANKING_COLLECTION || 'colorshift_records';
const CLASS_COLL    = window.RANKING_CLASS_COLLECTION || 'colorshift_classes';
const KEY_HAS_CLASS = !!window.RANKING_IDENTITY_INCLUDES_CLASS;
const USE_ANON      = !!window.RANKING_USE_ANONYMOUS_AUTH;

const SOLO_LIMIT  = window.RANKING_SOLO_LIMIT  || 30;   // 개인 순위에 보여줄 인원
const CLASS_LIMIT = window.RANKING_CLASS_LIMIT || 10;   // 반별 순위에 보여줄 반 수
const CACHE_MS    = 3 * 60 * 1000;                      // 순위표 캐시 시간

const SDK_VERSION = '10.12.2';
const SDK_BASE    = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';

const PROFILE_KEY  = 'css_profile_v1';   // 내 정보 (이 브라우저)
const LOCAL_DB_KEY = 'css_records_v1';   // 로컬 모드에서 쓰는 기록 저장소
const CACHE_KEY    = 'css_board_v1';     // 순위표 캐시
const MAX_STAGE    = 8;

/* 점수 우선, 같으면 스테이지 — 한 숫자로 합쳐 두면 정렬 색인 하나로 끝난다 */
function rankKeyOf(score, stage) { return score * 1000 + stage; }
function isBetter(a, b) {
  if (!b) return true;
  if (a.score !== b.score) return a.score > b.score;
  return a.stage > b.stage;
}

/* ------------------------------------------------------------
   1. 내 정보 (localStorage)
   ------------------------------------------------------------ */
function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return (p && p.nickname && p.studentId && p.name) ? p : null;
  } catch (e) { return null; }
}
function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {}
}

/* 같은 사람 판별용 문서 ID — 학번 + 이름 (설정에 따라 반 포함) */
function playerIdOf(p) {
  const clean = s => String(s).trim().replace(/\s+/g, '').replace(/[\/\\.#$\[\]]/g, '_');
  const parts = KEY_HAS_CLASS ? [p.klass, p.studentId, p.name] : [p.studentId, p.name];
  return parts.map(clean).join('-');
}

let profile = loadProfile();

/* ------------------------------------------------------------
   2. 저장소 — Firebase 가 설정되어 있으면 Firestore, 아니면 로컬
   ------------------------------------------------------------
   두 저장소 모두 아래 두 가지를 제공한다.
     submit(rec)         → { saved, best }
     loadBoard(profile)  → { players, classes, me, myRank, totalPlayers }
   ------------------------------------------------------------ */
const hasFirebase = !!(CFG.apiKey && CFG.projectId);
let backend      = null;
let backendLabel = '';

/* --- 로컬 모드 — 전부 이 브라우저 안에서 계산한다 --- */
function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_DB_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function writeLocal(db) {
  try { localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db)); } catch (e) {}
}

const localBackend = {
  async submit(rec) {
    const db = readLocal();
    const prev = db[rec.id] || null;
    const better = isBetter(rec, prev);
    db[rec.id] = {
      id: rec.id,
      nickname: rec.nickname, klass: rec.klass,
      studentId: rec.studentId, name: rec.name,
      score:   better ? rec.score   : prev.score,
      stage:   better ? rec.stage   : prev.stage,
      rankKey: better ? rec.rankKey : prev.rankKey,
      plays: (prev && prev.plays ? prev.plays : 0) + 1,
      updatedAt: Date.now()
    };
    writeLocal(db);
    return { saved: better, best: db[rec.id] };
  },

  async loadBoard(prof) {
    const db  = readLocal();
    const all = Object.keys(db).map(k => db[k]).sort((a, b) => b.rankKey - a.rankKey);

    const cmap = new Map();
    for (const r of all) {
      const k = Number(r.klass);
      if (!k) continue;
      if (!cmap.has(k)) cmap.set(k, { klass: k, total: 0, count: 0 });
      const c = cmap.get(k);
      c.total += Number(r.score || 0);
      c.count += 1;
    }
    const classes = Array.from(cmap.values()).sort((a, b) => b.total - a.total);

    let me = null, myRank = 0;
    if (prof) {
      const id = playerIdOf(prof);
      const i  = all.findIndex(r => r.id === id);
      if (i >= 0) { me = all[i]; myRank = all.filter(r => r.rankKey > me.rankKey).length + 1; }
    }
    return { players: all.slice(0, SOLO_LIMIT), classes: classes, me: me,
             myRank: myRank, totalPlayers: all.length };
  }
};

/* --- Firestore 모드 --- */
async function makeFirebaseBackend() {
  const appMod = await import(SDK_BASE + 'firebase-app.js');
  const fs     = await import(SDK_BASE + 'firebase-firestore.js');
  const app    = appMod.initializeApp(CFG);
  const db     = fs.getFirestore(app);

  if (USE_ANON) {
    const authMod = await import(SDK_BASE + 'firebase-auth.js');
    await authMod.signInAnonymously(authMod.getAuth(app));
  }

  const recs = () => fs.collection(db, COLL);
  const clss = () => fs.collection(db, CLASS_COLL);

  return {
    /* 기록 하나를 쓰면서 그 사람의 반 합계도 같이 고친다.
       트랜잭션은 읽기를 모두 끝낸 뒤에만 쓸 수 있어 순서를 지킨다. */
    async submit(rec) {
      const pRef = fs.doc(db, COLL, rec.id);

      return await fs.runTransaction(db, async tx => {
        const pSnap  = await tx.get(pRef);
        const prev   = pSnap.exists() ? pSnap.data() : null;
        const better = isBetter(rec, prev);

        const score   = better ? rec.score   : prev.score;
        const stage   = better ? rec.stage   : prev.stage;
        const rankKey = better ? rec.rankKey : prev.rankKey;

        const movedClass = !!(prev && Number(prev.klass) !== Number(rec.klass));
        const delta      = (prev && !movedClass) ? score - Number(prev.score || 0) : score;
        const addMember  = (prev && !movedClass) ? 0 : 1;
        const touchNew   = (delta !== 0 || addMember !== 0);

        // --- 읽기 (필요할 때만) ---
        const newRef = touchNew  ? fs.doc(db, CLASS_COLL, String(rec.klass))  : null;
        const oldRef = movedClass ? fs.doc(db, CLASS_COLL, String(prev.klass)) : null;
        const newCls = newRef ? await tx.get(newRef) : null;
        const oldCls = oldRef ? await tx.get(oldRef) : null;

        // --- 쓰기 ---
        const next = {
          nickname: rec.nickname, klass: rec.klass,
          studentId: rec.studentId, name: rec.name,
          score: score, stage: stage, rankKey: rankKey,
          plays: (prev && prev.plays ? prev.plays : 0) + 1,
          updatedAt: fs.serverTimestamp()
        };
        if (!prev) next.createdAt = fs.serverTimestamp();
        tx.set(pRef, next, { merge: true });

        if (oldRef) {   // 반을 옮겼다면 예전 반에서 빼준다
          const o = oldCls.exists() ? oldCls.data() : { total: 0, count: 0 };
          tx.set(oldRef, {
            klass: Number(prev.klass),
            total: Math.max(0, Number(o.total || 0) - Number(prev.score || 0)),
            count: Math.max(0, Number(o.count || 0) - 1),
            updatedAt: fs.serverTimestamp()
          }, { merge: true });
        }
        if (newRef) {
          const n = newCls.exists() ? newCls.data() : { total: 0, count: 0 };
          tx.set(newRef, {
            klass: Number(rec.klass),
            total: Math.max(0, Number(n.total || 0) + delta),
            count: Math.max(0, Number(n.count || 0) + addMember),
            updatedAt: fs.serverTimestamp()
          }, { merge: true });
        }

        return { saved: better, best: { score: score, stage: stage } };
      });
    },

    /* 상위 N명 + 반 문서 전부. 내가 상위 N명 밖이면 내 문서 하나와
       나보다 점수가 높은 사람 수(집계 쿼리)만 더 읽는다. */
    async loadBoard(prof) {
      const [topSnap, clsSnap] = await Promise.all([
        fs.getDocs(fs.query(recs(), fs.orderBy('rankKey', 'desc'), fs.limit(SOLO_LIMIT))),
        fs.getDocs(fs.query(clss(), fs.orderBy('total', 'desc'), fs.limit(60)))
      ]);

      const players = topSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const classes = clsSnap.docs.map(d => d.data())
        .filter(c => Number(c.count || 0) > 0)
        .sort((a, b) => Number(b.total || 0) - Number(a.total || 0));
      const totalPlayers = classes.reduce((s, c) => s + Number(c.count || 0), 0);

      let me = null, myRank = 0;
      if (prof) {
        const id = playerIdOf(prof);
        const i  = players.findIndex(p => p.id === id);
        if (i >= 0) {
          me = players[i];
          myRank = players.filter(p => Number(p.rankKey || 0) > Number(me.rankKey || 0)).length + 1;
        } else {
          const snap = await fs.getDoc(fs.doc(db, COLL, id));
          if (snap.exists()) {
            me = Object.assign({ id: id }, snap.data());
            const agg = await fs.getCountFromServer(
              fs.query(recs(), fs.where('rankKey', '>', Number(me.rankKey || 0))));
            myRank = agg.data().count + 1;
          }
        }
      }
      return { players: players, classes: classes, me: me,
               myRank: myRank, totalPlayers: totalPlayers };
    }
  };
}

async function initBackend() {
  if (!hasFirebase) {
    backend = localBackend;
    backendLabel = '로컬 저장 모드 — 이 브라우저에만 기록이 남습니다';
    return;
  }
  try {
    backend = await makeFirebaseBackend();
    backendLabel = 'Firebase 연결됨';
  } catch (e) {
    backend = localBackend;
    backendLabel = 'Firebase 연결 실패, 임시로 로컬에만 저장합니다 (' + ((e && e.message) || e) + ')';
  }
}

/* ------------------------------------------------------------
   3. DOM
   ------------------------------------------------------------ */
const $ = id => document.getElementById(id);

const modal    = $('regBackdrop');
const form     = $('regForm');
const fNick    = $('fNick');
const fClass   = $('fClass');
const fNo      = $('fNo');
const fName    = $('fName');
const fAgree   = $('fAgree');
const regErr   = $('regErr');
const regTitle = $('regTitle');
const regLead  = $('regLead');
const regNote  = $('regEditNote');
const regOk    = $('regOk');

const statusEl  = $('rankStatus');
const mineEl    = $('rankMine');
const soloBody  = $('soloBody');
const classBody = $('classBody');
const soloPane  = $('soloPane');
const classPane = $('classPane');
const tabSolo   = $('tabSolo');
const tabClass  = $('tabClass');
const toastEl   = $('rankToast');

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------
   4. 등록 화면
   ------------------------------------------------------------ */
let pendingResult = null;    // 정보를 입력하기 전에 끝난 판의 기록

function openModal(edit) {
  regTitle.textContent = edit ? '내 정보 수정' : '플레이어 정보 입력';
  regLead.textContent  = edit
    ? '순위표에 표시되는 닉네임과 반을 바꿀 수 있습니다.'
    : (pendingResult
        ? '방금 끝난 판의 기록을 남기려면 아래 정보를 입력해 주세요.'
        : '순위표에 기록을 남기려면 아래 정보를 입력해 주세요.');
  regOk.textContent     = edit ? '저장' : '저장하고 시작';
  regNote.style.display = edit ? 'block' : 'none';
  if (profile) {
    fNick.value  = profile.nickname;
    fClass.value = profile.klass;
    fNo.value    = profile.studentId;
    fName.value  = profile.name;
    fAgree.checked = true;
  }
  regErr.textContent = '';
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
  setTimeout(() => fNick.focus(), 60);
}
function closeModal() {
  modal.classList.remove('show');
  document.body.style.overflow = '';
}

function readForm() {
  const nickname  = fNick.value.trim();
  const klass     = parseInt(fClass.value, 10);
  const studentId = fNo.value.trim();
  const name      = fName.value.trim();

  if (nickname.length < 1 || nickname.length > 12) return { err: '닉네임은 1~12자로 입력해 주세요.' };
  if (!(klass >= 1 && klass <= 20))                 return { err: '반은 1~20 사이의 숫자로 입력해 주세요.' };
  if (!/^[0-9]{1,6}$/.test(studentId))              return { err: '학번은 숫자 1~6자리로 입력해 주세요.' };
  if (name.length < 1 || name.length > 10)          return { err: '이름은 1~10자로 입력해 주세요.' };
  if (!fAgree.checked)                              return { err: '안내 사항을 확인했는지 체크해 주세요.' };

  return { profile: { nickname: nickname, klass: klass, studentId: studentId, name: name } };
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const r = readForm();
  if (r.err) { regErr.textContent = r.err; return; }

  profile = r.profile;
  saveProfile(profile);
  closeModal();
  renderMine();

  if (pendingResult) {
    const p = pendingResult;
    pendingResult = null;
    await submitResult(p.score, p.stage);
  } else {
    refresh(true);
  }
});

$('regLater').addEventListener('click', e => {
  e.preventDefault();
  closeModal();
  renderMine();
});

/* ------------------------------------------------------------
   5. 기록 제출
   ------------------------------------------------------------ */
let submitting = false;

async function submitResult(score, stage) {
  if (!profile) {                 // 정보 없이 끝난 판 — 입력받은 뒤 이어서 저장한다
    pendingResult = { score: score, stage: stage };
    openModal(false);
    return;
  }
  if (submitting) return;
  submitting = true;
  try {
    const rec = {
      id: playerIdOf(profile),
      nickname:  profile.nickname,
      klass:     profile.klass,
      studentId: profile.studentId,
      name:      profile.name,
      score:   score,
      stage:   stage,
      rankKey: rankKeyOf(score, stage)
    };
    const res = await backend.submit(rec);

    toast(res.saved
      ? '새 최고 기록! ' + score.toLocaleString() + '점 · STAGE ' + stageLabel(stage)
      : '기록했습니다 — 최고 기록은 ' + Number(res.best.score).toLocaleString() + '점 · STAGE ' + stageLabel(res.best.stage));

    // 내 기록 카드만 곧바로 고치고, 순위표는 화면에 보일 때 다시 읽는다 (읽기 절약)
    if (!board.me) board.me = { id: rec.id, nickname: rec.nickname, klass: rec.klass, plays: 0 };
    board.me.score   = res.best.score;
    board.me.stage   = res.best.stage;
    board.me.rankKey = rankKeyOf(res.best.score, res.best.stage);
    board.me.plays   = Number(board.me.plays || 0) + 1;
    invalidate();
    if (sectionVisible) await refresh(true); else renderMine();
  } catch (e) {
    toast('기록 저장에 실패했습니다 — ' + ((e && e.message) || e), true);
  } finally {
    submitting = false;
  }
}

let toastTimer = 0;
function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('err', !!isError);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4600);
}

/* ------------------------------------------------------------
   6. 순위표
   ------------------------------------------------------------ */
let board   = { players: [], classes: [], me: null, myRank: 0, totalPlayers: 0, at: 0 };
let loading = false;

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && c.at && Date.now() - c.at < CACHE_MS) return c;
  } catch (e) {}
  return null;
}
function writeCache(b) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(b)); } catch (e) {}
}
function invalidate() {
  board.at = 0;
  try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
}

async function refresh(force) {
  if (loading) return;
  if (!force && board.at && Date.now() - board.at < CACHE_MS) return;   // 아직 싱싱하다

  loading = true;
  statusEl.textContent = '순위를 불러오는 중…';
  try {
    const b = await backend.loadBoard(profile);
    b.at = Date.now();
    board = b;
    writeCache(b);
    statusEl.textContent = backendLabel + ' · 참가자 ' + b.totalPlayers + '명';
  } catch (e) {
    statusEl.textContent = '순위를 불러오지 못했습니다 — ' + ((e && e.message) || e);
  } finally {
    loading = false;
    renderSolo(); renderClass(); renderMine();
  }
}

function medal(n) { return n === 1 ? 'g' : n === 2 ? 's' : n === 3 ? 'b' : ''; }
function stageLabel(s) {
  const n = Number(s || 0);
  return n >= MAX_STAGE ? 'FINAL' : String(n);
}
function num(v) { return Number(v || 0).toLocaleString(); }

/* 동점이면 같은 순위, 다음은 그만큼 건너뛴다 (1, 2, 2, 4 …) */
function rankNumbers(list, keyOf) {
  const out = [];
  let rank = 0, prev = null;
  list.forEach((item, i) => {
    const k = keyOf(item);
    if (prev === null || k !== prev) { rank = i + 1; prev = k; }
    out.push(rank);
  });
  return out;
}
function gapRow(cols) {
  return '<tr class="gap"><td colspan="' + cols + '">⋯</td></tr>';
}

function renderSolo() {
  const myId  = profile ? playerIdOf(profile) : null;
  const list  = board.players.slice(0, SOLO_LIMIT);
  const ranks = rankNumbers(list, r => Number(r.rankKey || 0));

  if (!list.length) {
    soloBody.innerHTML = '<tr><td colspan="4" class="empty">아직 기록이 없습니다. 첫 번째 기록을 남겨보세요.</td></tr>';
    return;
  }

  let html = list.map((r, i) => soloRow(ranks[i], r, r.id === myId)).join('');

  // 내가 상위권 밖이면 ⋯ 아래에 내 줄을 따로 붙인다
  const inList = myId && list.some(r => r.id === myId);
  if (!inList && board.me && board.myRank) {
    html += gapRow(4) + soloRow(board.myRank, board.me, true);
  }
  soloBody.innerHTML = html;
}
function soloRow(rank, r, me) {
  return '<tr class="' + (me ? 'me' : '') + '">'
    + '<td class="rk ' + medal(rank) + '">' + rank + '</td>'
    + '<td class="nick">' + esc(r.nickname || '-') + (me ? '<span class="tag">나</span>' : '') + '</td>'
    + '<td class="num">' + num(r.score) + '</td>'
    + '<td class="num st">' + stageLabel(r.stage) + '</td>'
    + '</tr>';
}

function renderClass() {
  const myClass = profile ? Number(profile.klass) : 0;
  const all     = board.classes;
  const list    = all.slice(0, CLASS_LIMIT);
  const ranks   = rankNumbers(all, c => Number(c.total || 0));

  if (!list.length) {
    classBody.innerHTML = '<tr><td colspan="4" class="empty">아직 기록이 없습니다.</td></tr>';
    return;
  }

  let html = list.map((c, i) => classRow(ranks[i], c, Number(c.klass) === myClass)).join('');

  const mineIdx = all.findIndex(c => Number(c.klass) === myClass);
  if (myClass && mineIdx >= CLASS_LIMIT) {
    html += gapRow(4) + classRow(ranks[mineIdx], all[mineIdx], true);
  }
  classBody.innerHTML = html;
}
function classRow(rank, c, me) {
  return '<tr class="' + (me ? 'me' : '') + '">'
    + '<td class="rk ' + medal(rank) + '">' + rank + '</td>'
    + '<td class="nick">' + Number(c.klass) + '반' + (me ? '<span class="tag">우리 반</span>' : '') + '</td>'
    + '<td class="num">' + num(c.total) + '</td>'
    + '<td class="num">' + Number(c.count || 0) + '명</td>'
    + '</tr>';
}

function stat(label, value) {
  return '<div class="stat"><span class="sl">' + label + '</span><span class="sv">' + value + '</span></div>';
}

function renderMine() {
  if (!profile) {
    mineEl.innerHTML =
      '<div class="mine-empty">'
      + '<p>아직 플레이어 정보를 입력하지 않았습니다. 정보를 입력해야 기록이 순위표에 올라갑니다.</p>'
      + '<button type="button" class="tool" id="btnRegNow">정보 입력하기</button>'
      + '</div>';
    $('btnRegNow').addEventListener('click', () => openModal(false));
    return;
  }
  const me = board.me;
  mineEl.innerHTML =
    '<div class="mine-head">'
    + '<span class="mine-nick">' + esc(profile.nickname) + '</span>'
    + '<span class="mine-meta">' + Number(profile.klass) + '반 · 순위표에는 닉네임만 공개됩니다</span>'
    + '</div>'
    + '<div class="mine-stats">'
    + stat('내 순위',       me && board.myRank ? board.myRank + '위' : '—')
    + stat('최고 점수',     me ? num(me.score) : '—')
    + stat('도달 스테이지',  me ? stageLabel(me.stage) : '—')
    + stat('플레이 횟수',    me && me.plays ? me.plays + '회' : '—')
    + '</div>';
}

/* 탭 — 순위표를 건드렸다는 건 보고 있다는 뜻이니 이때도 (캐시가 상했으면) 다시 읽는다 */
function selectTab(which) {
  const solo = (which === 'solo');
  tabSolo.classList.toggle('on', solo);
  tabClass.classList.toggle('on', !solo);
  soloPane.style.display  = solo ? '' : 'none';
  classPane.style.display = solo ? 'none' : '';
  if (backend) refresh(false);
}
tabSolo.addEventListener('click', () => selectTab('solo'));
tabClass.addEventListener('click', () => selectTab('class'));

// 상단 바의 `랭킹` 링크로 내려오는 경우도 대비 (IntersectionObserver 가 안 먹는 환경 보험)
const navRank = document.querySelector('a[href="#rank"]');
if (navRank) navRank.addEventListener('click', () => setTimeout(() => refresh(false), 500));

$('btnRankRefresh').addEventListener('click', () => refresh(true));
$('btnEditProfile').addEventListener('click', () => openModal(true));

/* ------------------------------------------------------------
   7. 게임(iframe)에서 오는 결과 받기
   ------------------------------------------------------------ */
/* 우리 게임 프레임에서 온 것만 받는다.
   Apps Script 처럼 게임이 iframe 안의 iframe 으로 들어가면 보낸 창이 프레임 자신이
   아닐 수 있어, 그때는 출처(origin)가 같은지로 확인한다. */
function isFromGame(e) {
  const frame = $('gameFrame');
  if (!frame) return false;
  if (e.source === frame.contentWindow) return true;
  try {
    const gameOrigin = new URL(frame.getAttribute('src'), location.href).origin;
    // 같은 출처에 게임을 두었다면 위의 검사만으로 충분하다 (이 페이지 자신의 메시지를 막는다)
    if (gameOrigin === location.origin) return false;
    return e.origin === gameOrigin;
  } catch (err) { return false; }
}

let lastMsg = '', lastMsgAt = 0;

window.addEventListener('message', e => {
  const d = e.data;
  if (!d || d.type !== 'colorshift:gameover') return;
  if (!isFromGame(e)) return;

  const score = Math.max(0, Math.floor(Number(d.score) || 0));
  const stage = Math.min(MAX_STAGE, Math.max(1, Math.floor(Number(d.stage) || 1)));

  // 부모와 최상위에 같은 결과가 두 번 올 수 있어 한 번만 처리한다
  const sig = score + '/' + stage, now = Date.now();
  if (sig === lastMsg && now - lastMsgAt < 2000) return;
  lastMsg = sig; lastMsgAt = now;

  submitResult(score, stage);
});

/* ------------------------------------------------------------
   8. 시작 — 순위표가 화면에 들어올 때만 읽는다
   ------------------------------------------------------------ */
let sectionVisible = false;

(async function boot() {
  selectTab('solo');

  const cached = readCache();          // 3분 안에 본 적 있으면 그대로 그린다
  if (cached) {
    board = cached;
    statusEl.textContent = '최근에 불러온 순위입니다 · 참가자 ' + board.totalPlayers + '명';
    renderSolo(); renderClass();
  }
  renderMine();

  await initBackend();

  const section = $('rank');
  if (section && 'IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      sectionVisible = entries.some(en => en.isIntersecting);
      if (sectionVisible) refresh(false);
    }, { rootMargin: '200px' }).observe(section);
  } else {
    await refresh(false);              // 옛 브라우저면 그냥 한 번 읽는다
  }
  // 창 높이를 알 수 없는 환경(숨겨진 창 등)에서는 관찰이 동작하지 않으니 한 번은 읽어 둔다
  setTimeout(() => { if (!board.at && !window.innerHeight) refresh(false); }, 1200);

  if (!profile) openModal(false);      // 첫 방문
})();

})();
