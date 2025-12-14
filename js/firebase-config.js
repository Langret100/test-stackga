// Firebase 설정 (메신저 방식)
// - apiKey는 GitHub Pages 배포 시 Secrets(FIREBASE_API_KEY)로 주입: __FIREBASE_API_KEY__
// - 나머지 값은 본인 Firebase 프로젝트 값으로 채우세요(메신저 압축의 social-chat-firebase.js 참고)
// - window.SOCIAL_CHAT_FIREBASE_CONFIG 또는 window.STACK_GAME_FIREBASE_CONFIG 로 재정의 가능

let cfg = {
  apiKey: "__FIREBASE_API_KEY__",
  authDomain: "__FIREBASE_AUTH_DOMAIN__",
  databaseURL: "__FIREBASE_DATABASE_URL__",
  projectId: "__FIREBASE_PROJECT_ID__",
  storageBucket: "__FIREBASE_STORAGE_BUCKET__",
  messagingSenderId: "__FIREBASE_MESSAGING_SENDER_ID__",
  appId: "__FIREBASE_APP_ID__"
};

if (typeof window !== "undefined") {
  if (window.SOCIAL_CHAT_FIREBASE_CONFIG) cfg = window.SOCIAL_CHAT_FIREBASE_CONFIG;
  if (window.STACK_GAME_FIREBASE_CONFIG) cfg = window.STACK_GAME_FIREBASE_CONFIG;
}

export const firebaseConfig = cfg;
