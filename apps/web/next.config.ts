import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  // 모노레포 공유 패키지(packages/shared-types)를 TS 소스 그대로 트랜스파일해 소비한다
  // (별도 빌드 산출물 없음 — SPOT 상수 단일 정의점, D5 결정).
  transpilePackages: ["shared-types"],
};

export default nextConfig;
