/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI } from "@google/genai";
import { StrategicHint, AiResponse, DebugInfo } from "../types";

let ai: GoogleGenAI | null = null;
if (process.env.API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
} else {
  console.error("API_KEY is missing from environment variables.");
}

const MODEL_NAME = "gemini-3-flash-preview";

export interface TargetCandidate {
  id: string;
  color: string;
  size: number;
  row: number;
  col: number;
  pointsPerBubble: number;
  description: string;
}

export const getStrategicHint = async (
  imageBase64: string,
  validTargets: TargetCandidate[],
  dangerRow: number
): Promise<AiResponse> => {
  const startTime = performance.now();

  const debug: DebugInfo = {
    latency: 0,
    screenshotBase64: imageBase64,
    promptContext: "",
    rawResponse: "",
    timestamp: new Date().toLocaleTimeString()
  };

  if (!ai) {
    return {
      hint: { message: "API Key가 없습니다." },
      debug: { ...debug, error: "API Key Missing" }
    };
  }

  const getBestLocalTarget = (msg: string = "방어적으로 플레이하세요."): StrategicHint => {
    if (validTargets.length > 0) {
      const best = validTargets.sort((a, b) => {
        const scoreA = a.size * a.pointsPerBubble;
        const scoreB = b.size * b.pointsPerBubble;
        return (scoreB - scoreA) || (a.row - b.row);
      })[0];
      return {
        message: `정답 ${best.description} 쪽으로 발사하세요!`,
        rationale: "가장 많은 구슬을 터뜨릴 수 있는 위치입니다.",
        targetRow: best.row,
        targetCol: best.col,
        recommendedColor: best.color as any
      };
    }
    return { message: msg, rationale: "현재 유효한 클러스터가 없습니다." };
  };

  const hasTargets = validTargets.length > 0;
  const targetListStr = hasTargets
    ? validTargets.map(t =>
        `- 정답=${t.description}, 색=${t.color.toUpperCase()}, 클러스터 크기=${t.size}, [Row ${t.row}, Col ${t.col}], 총 점수=${t.size * t.pointsPerBubble}`
      ).join("\n")
    : "현재 매칭 가능한 구슬 없음. 미래 콤보를 위한 배치 추천.";

  debug.promptContext = targetListStr;

  const prompt = `
    당신은 수학 학습 버블 슈터 게임의 AI 전략가입니다.
    이 게임에서 플레이어는 수식이 적힌 구슬을 쏩니다. 같은 정답의 구슬 3개 이상이 연결되면 터집니다.
    예: 3×4, 2×6, 12는 모두 정답이 12이므로 같은 그룹입니다.

    ### 게임 상태
    - 위험도: ${dangerRow >= 6 ? "위험! 구슬이 바닥에 가깝습니다!" : "안정"}
    
    ### 현재 발사 가능한 목표 (모든 정답값)
    ${targetListStr}

    ### 임무
    화면을 보고 최선의 전략을 추천하세요:
    1. 가장 많은 구슬을 터뜨릴 수 있는 정답값을 선택하세요.
    2. 정확한 위치를 알려주세요.
    3. 아이들이 이해하기 쉽게 설명해주세요.
    
    우선순위:
    1. 가장 큰 클러스터 공략 (많은 구슬 제거)
    2. 연쇄 폭발 가능성 높은 위치
    3. 위험도가 높으면 가장 낮은 구슬부터 제거

    ### 출력 형식 (RAW JSON만, 마크다운 없이)
    {
      "message": "한국어로 짧은 지시 (예: '정답 12 구슬을 겨냥하세요!')",
      "rationale": "한국어로 전략 설명 한 문장",
      "recommendedColor": "red|blue|green|yellow|purple|orange",
      "targetRow": 정수,
      "targetCol": 정수
    }
  `;

  try {
    const cleanBase64 = imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: {
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: cleanBase64 } }
        ]
      },
      config: {
        maxOutputTokens: 1024,
        temperature: 0.3,
        responseMimeType: "application/json"
      }
    });

    const endTime = performance.now();
    debug.latency = Math.round(endTime - startTime);

    let text = response.text || "{}";
    debug.rawResponse = text;

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      text = text.substring(firstBrace, lastBrace + 1);
    }

    try {
      const json = JSON.parse(text);
      debug.parsedResponse = json;
      const r = Number(json.targetRow);
      const c = Number(json.targetCol);
      if (!isNaN(r) && !isNaN(c) && json.recommendedColor) {
        return {
          hint: {
            message: json.message || "좋은 위치를 찾았어요!",
            rationale: json.rationale,
            targetRow: r,
            targetCol: c,
            recommendedColor: json.recommendedColor.toLowerCase()
          },
          debug
        };
      }
      return {
        hint: getBestLocalTarget("AI가 잘못된 좌표를 반환했습니다"),
        debug: { ...debug, error: "Invalid Coordinates in JSON" }
      };
    } catch (e: any) {
      return {
        hint: getBestLocalTarget("AI 응답 파싱 오류"),
        debug: { ...debug, error: `JSON Parse Error: ${e.message}` }
      };
    }
  } catch (error: any) {
    const endTime = performance.now();
    debug.latency = Math.round(endTime - startTime);
    return {
      hint: getBestLocalTarget("AI 서비스에 연결할 수 없습니다"),
      debug: { ...debug, error: error.message || "Unknown API Error" }
    };
  }
};
