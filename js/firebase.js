import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase, ref, set, get, update, remove, onValue, onDisconnect, serverTimestamp,
  push, child, runTransaction, off
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

export function initFirebase(){
  const app = initializeApp(firebaseConfig);
  const db = getDatabase(app);
  return { app, db, api: { ref, set, get, update, remove, onValue, onDisconnect, serverTimestamp, push, child, runTransaction, off } };
}

export function makeId(len=10){
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  for(let i=0;i<len;i++) out += chars[arr[i] % chars.length];
  return out;
}

export function nowMs(){ return Date.now(); }
