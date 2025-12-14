# 쌓기게임 (메신저 수정 없음)

## 동작 개요
- 이 프로젝트는 **게임 페이지만으로** 2인 온라인 대결(실시간)을 구현합니다.
- 접속 주소는 **하나만** 사용합니다. (예: GitHub Pages 주소)
- 같은 주소로 들어온 사람을 **2명씩 자동 매칭**해서 최대 **10팀 동시** 플레이가 가능합니다.
- **20초 내 상대가 매칭되지 않으면 PC 대전(1인 모드)**으로 자동 전환합니다.

## Firebase
- Firebase 프로젝트: `web-ghost-c447b` (메신저와 동일)
- GitHub Pages 배포 시 `__FIREBASE_API_KEY__`는 GitHub Secrets의 `FIREBASE_API_KEY`로 치환되는 구조입니다.

## 보안 규칙(현재 구현 기준)
이 게임은 아래 경로만 사용합니다:
- `signals/{roomId}/{signalId}`

사용자가 제공한 Rules 예시(그대로 사용 가능):
```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "socialChatRooms": {
      "$roomId": { "$msgId": { ".read": true, ".write": true } }
    },
    "signals": {
      "$roomId": { "$signalId": { ".read": true, ".write": true } }
    }
  }
}
```

## 기록 삭제(로그 남기지 않기)
- 게임 종료 시 `signals/{roomId}` 아래의 `meta/players/states/events`를 **즉시 삭제(best-effort)** 합니다.
- 탭 종료/뒤로가기 시에도 `onDisconnect`로 자신의 `players/states` 흔적을 지웁니다.

## 로컬 실행 주의
- `file://`로 열면 모듈이 차단됩니다.
- GitHub Pages(https) 또는 로컬 서버(http)로 실행하세요.
  - 예) `python -m http.server 5500` → `http://localhost:5500`

## 사운드
- BGM: `assets/arcade-music.mp3` (첨부 파일 사용)
- SFX: WebAudio로 합성(추가 음원 파일 없음)
- 모바일은 최초 터치/클릭 후 사운드가 시작됩니다. (상단 🔊 버튼으로 음소거 토글)
