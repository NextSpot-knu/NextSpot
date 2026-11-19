// 진입 — 저장소 대역을 라우터보다 먼저 깐다(웹 코드가 모듈 평가 때 저장소를 읽을 수 있다).
import './lib/storageInstall';
import './lib/webSetup';
import './lib/sessionStorage';
import 'expo-router/entry';
