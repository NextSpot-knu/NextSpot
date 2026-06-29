'use client';

import { usePathname } from 'next/navigation';

export default function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div
      key={pathname}
      className="flex-1 flex flex-col h-full w-full relative animate-page-enter"
    >
      {children}
    </div>
  );
}
