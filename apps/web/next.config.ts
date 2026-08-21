import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: 'export',
  // 사용자 홈의 우연한 package-lock.json을 루트로 오인하지 않고, 공유 패키지가 있는 저장소를 고정한다.
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
  images: {
    unoptimized: true,
  },
  // 모노레포 공유 패키지(packages/shared-types)를 TS 소스 그대로 트랜스파일해 소비한다
  // (별도 빌드 산출물 없음 — SPOT 상수 단일 정의점, D5 결정).
  transpilePackages: ["shared-types"],
};

export default nextConfig;
