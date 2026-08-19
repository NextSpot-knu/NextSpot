import Image from 'next/image';

type NextSpotMascotProps = {
  variant?: 'avatar' | 'full';
  className?: string;
};

/**
 * NextSpot의 경주 여행 길잡이 마스코트.
 * 장식용 이미지이므로 주변의 실제 텍스트/컨트롤을 스크린리더 레이블로 사용한다.
 */
export default function NextSpotMascot({
  variant = 'avatar',
  className = '',
}: NextSpotMascotProps) {
  const isAvatar = variant === 'avatar';

  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 overflow-hidden bg-hanji ${
        isAvatar
          ? 'aspect-square rounded-full border border-gold/35 shadow-sm'
          : 'aspect-[4/5] rounded-[28%]'
      } ${className}`}
    >
      <Image
        src="/mascot/nextspot-guide.webp"
        alt=""
        fill
        sizes={isAvatar ? '48px' : '96px'}
        unoptimized
        draggable={false}
        className={
          isAvatar
            ? 'pointer-events-none select-none object-cover object-[50%_22%] scale-[1.48]'
            : 'pointer-events-none select-none object-cover object-[50%_42%]'
        }
      />
    </span>
  );
}
