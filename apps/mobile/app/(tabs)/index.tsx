import { Text, View } from 'react-native';

import { congestionKey } from '@/lib/congestionScale';

// 1단계 연결 확인용 임시 화면 — 웹 순수 모듈(congestionScale)을 그대로 import 하고 NativeWind 클래스로 그린다.
export default function HomeScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-white">
      <Text className="text-xl font-bold">NextSpot</Text>
      <Text className="mt-2 text-base">0.8 → {congestionKey(0.8)}</Text>
    </View>
  );
}
