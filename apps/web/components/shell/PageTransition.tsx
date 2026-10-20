export default function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-0 flex flex-col h-full w-full relative">
      {children}
    </div>
  );
}
