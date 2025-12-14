// Firebase 설정 (메신저 프로젝트 방식과 동일)
// - apiKey 는 커밋하지 않고 __FIREBASE_API_KEY__ 플레이스홀더로 둡니다.
// - GitHub Pages 배포 시, .github/workflows/pages.yml 에서 Secrets(FIREBASE_API_KEY)로 치환할 수 있습니다.
// - 필요하면 index.html 에서 window.STACK_GAME_FIREBASE_CONFIG 로 재정의할 수 있습니다.

const DEFAULT_CONFIG = {
  apiKey: "__FIREBASE_API_KEY__",
  authDomain: "web-ghost-c447b.firebaseapp.com",
  databaseURL: "https://web-ghost-c447b-default-rtdb.firebaseio.com",
  projectId: "web-ghost-c447b",
  storageBucket: "web-ghost-c447b.firebasestorage.app",
  messagingSenderId: "198377381878",
  appId: "1:198377381878:web:83b56b1b4d63138d27b1d7"
};

export const firebaseConfig = (typeof window !== 'undefined' && window.STACK_GAME_FIREBASE_CONFIG)
  ? window.STACK_GAME_FIREBASE_CONFIG
  : DEFAULT_CONFIG;
