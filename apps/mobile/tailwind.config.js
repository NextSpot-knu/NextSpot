// 색·글꼴은 lib/theme/tokens.ts 한 곳에서 온다(웹 globals.css 와 같은 이름 — bg-hanji · text-muk · text-gold …).
// tailwindcss/loadConfig 가 jiti 로 읽으므로 .ts 를 require 할 수 있다.
const { colors, fontFamilies } = require('./lib/theme/tokens.ts');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './features/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  // 앱은 라이트 테마만 쓴다(app.json userInterfaceStyle: light).
  darkMode: 'class',
  theme: {
    extend: {
      colors,
      // 안드로이드는 굵기마다 family 이름이 따로라 font-bold 만으로는 굵어지지 않는다 — ~/components/ui 의 Text 가
      // className 의 font-bold 등을 읽어 아래 family 로 바꿔 준다. RN Text 를 직접 쓸 때만 font-sans-bold 처럼 적는다.
      fontFamily: {
        sans: [fontFamilies.regular],
        serif: [fontFamilies.regular],
        'sans-medium': [fontFamilies.medium],
        'sans-semibold': [fontFamilies.semibold],
        'sans-bold': [fontFamilies.bold],
        'sans-extrabold': [fontFamilies.extrabold],
        'sans-black': [fontFamilies.black],
      },
    },
  },
  plugins: [],
};
