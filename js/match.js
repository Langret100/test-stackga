/**
 * Feature: HUD 상단 소리 버튼 옆에 "매칭" 버튼을 두고,
 *          클릭 시 페이지를 새로고침하여 온라인 매칭을 다시 시도합니다.
 *
 * Remove:
 *  - index.html: #btnMatch 버튼 제거
 *  - css/game.css: .matchBtn 스타일 제거
 *  - js/main.js: 이 모듈 import / init 호출 제거
 *  - js/match.js 파일 삭제
 */

export function initMatchButton({ buttonEl, audio } = {}){
  if(!buttonEl) return;

  buttonEl.addEventListener("click", ()=>{
    // iOS 등에서 사운드가 사용자 제스처로만 허용되는 경우가 있어
    // 클릭 순간 gestureStart를 시도합니다(실패해도 무시).
    try{ audio?.gestureStart?.(); }catch{}

    // 새로고침 -> 재부팅/재매칭 루프가 다시 시작됨
    location.reload();
  });
}
