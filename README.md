# 쌓기게임 (메신저 수정 없음)

## 동작 개요
- 이 프로젝트는 **게임 페이지만으로** 2인 온라인 대결(실시간)을 구현합니다.
- 메신저는 수정하지 않습니다.
- QR은 사용자가 직접 만들고, **QR 내용(텍스트) 자체에 '초대 문구 + 링크'를 넣는 방식**으로 스캔 시 대화방에 문구가 그대로 올라가게 합니다.

## 사용 방법 (GitHub Pages)
1) Firebase Realtime Database 프로젝트를 준비합니다.
2) `js/firebase-config.js`의 authDomain/databaseURL/... 를 본인 설정으로 채웁니다.
   - apiKey는 `__FIREBASE_API_KEY__`로 남겨두고, GitHub Secrets(FIREBASE_API_KEY)로 주입하도록 `.github/workflows/pages.yml`이 포함되어 있습니다(메신저 프로젝트와 동일).
3) GitHub Pages로 배포합니다.
4) 사이트 접속(lobby 파라미터 없으면 자동으로 **초대 생성**) → 화면에 뜨는 **QR용 문구**를 그대로 QR로 만듭니다.
5) 상대가 QR을 스캔하면 대화방에 문구+링크가 올라가고, 상대가 링크로 접속하면 **2명 모였을 때 자동 시작(같은 링크에서 최대 10팀까지 각자 매칭)**합니다.
6) **20초 내에 상대가 들어오지 않으면 자동으로 PC 대전(1인 모드)**로 전환됩니다.

## 주의 (로컬 실행)
- Chrome에서 `file://`로 직접 열면 ES Module 스크립트가 차단되어 에러가 납니다.
- GitHub Pages(https)로 실행하거나, 로컬 서버(http)로 실행하세요.
  - 예) `python -m http.server 5500` 후 `http://localhost:5500` 접속

## Firebase 보안 규칙(예시)
테스트용으로만 사용하세요. 서비스 운영 시 보안 강화가 필요합니다.

```
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

## 기록 삭제
- 참가자는 브라우저 종료/퇴장 시 자신의 player/state를 `onDisconnect`로 삭제합니다.
- 방에 남은 사람이 없으면 마지막 사용자가 방 전체 삭제를 시도합니다(클라이언트에서 best-effort).

## 모바일 조작
- 탭: 회전
- 좌/우 스와이프: 이동(연속)
- 아래 스와이프: 내리기(연속)
- 강하게 아래: 하드드롭
