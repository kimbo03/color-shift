/* ============================================================
   COLOR SHIFT SHOOTER — Firebase 설정값
   ------------------------------------------------------------
   Firebase 프로젝트를 만들기 전에는 아래 값을 비워 두면 됩니다.
   비어 있으면 랭킹이 이 브라우저 안에서만 저장되는 "로컬 모드"로
   동작하므로, 등록 화면과 순위표를 미리 확인할 수 있습니다.

   Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹) 에서 받은 값을
   그대로 아래에 붙여 넣으면 곧바로 실서버 랭킹으로 바뀝니다.
   자세한 절차는 FIREBASE_설정안내.md 를 참고하세요.
   ============================================================ */

window.FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAEpoYx2kVatjbCVkmPxndnlSD66YY6m7o",
  authDomain:        "color-shift-shooter.firebaseapp.com",
  projectId:         "color-shift-shooter",
  storageBucket:     "color-shift-shooter.firebasestorage.app",
  messagingSenderId: "413456632961",
  appId:             "1:413456632961:web:f1095491bd7192856b5180"
};

/* 기록이 쌓이는 Firestore 컬렉션 이름 */
window.RANKING_COLLECTION = "colorshift_records";

/* 반별 합계를 모아 두는 컬렉션 — 반별 순위를 반 개수만큼만 읽으면 되게 해 준다 */
window.RANKING_CLASS_COLLECTION = "colorshift_classes";

/* 학번·이름만 따로 담는 컬렉션.
   보안 규칙에서 읽기를 막아 두기 때문에 Firebase 콘솔에서만 볼 수 있다.
   순위표에 쓰이는 기록에는 학번·이름이 들어가지 않는다. */
window.RANKING_IDENTITY_COLLECTION = "colorshift_identities";

/* 문서 ID 를 만들 때 섞는 값. 학번·이름을 그대로 ID 로 쓰지 않기 위한 것이다.
   코드에 들어 있으니 비밀은 아니고, 문서 목록을 훑어 이름을 줍는 것을 막는 용도다.
   한 번 정하면 바꾸지 마세요 — 바꾸면 기존 기록과 이어지지 않습니다. */
window.RANKING_ID_SALT = "color-shift-shooter-2026";

/* 입력받는 학년·반 범위 (1부터 이 값까지).
   학년을 바꾸면 Firestore 보안 규칙의 grade 범위도 같이 바꿔야 합니다. */
window.RANKING_MAX_GRADE = 3;
window.RANKING_MAX_CLASS = 20;

/* 순위표에 보여줄 개수. 그 아래에 있으면 ⋯ 뒤에 내 줄이 따로 붙는다.
   읽기 비용과 직결되니 참가자가 많아지면 줄이세요. */
window.RANKING_SOLO_LIMIT  = 30;   // 개인 순위 (명)
window.RANKING_CLASS_LIMIT = 10;   // 반별 순위 (반)

/* 같은 사람을 판별하는 기준.
   false — 학번 + 이름   (기본값)
   true  — 반 + 학번 + 이름
   학번이 반 안에서만 매겨지는 "번호"라서 다른 반에 같은 번호가 있다면 true 로 바꾸세요. */
window.RANKING_IDENTITY_INCLUDES_CLASS = false;

/* 익명 로그인 사용 여부.
   Firebase 콘솔 → Authentication → 로그인 방법 → 익명 을 켠 뒤 true 로 바꾸면
   보안 규칙에서 로그인한 사용자만 쓰기를 허용할 수 있습니다. */
window.RANKING_USE_ANONYMOUS_AUTH = false;
