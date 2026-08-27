'use client';

import { Toaster } from 'sonner';
import { useTheme } from './ThemeProvider';

export default function ThemeToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="bottom-center"
      theme={resolvedTheme}
      richColors
      toastOptions={{
        style: {
          background: 'var(--nextspot-hanji)',
          border: '1px solid var(--nextspot-line)',
          color: 'var(--nextspot-muk)',
        },
        className: 'backdrop-blur-md',
      }}
    />
  );
}
