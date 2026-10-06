'use client';

import React from 'react';
import SPOTSimulator from '@/components/admin/SPOTSimulator';
import { AdminSidebar } from '@/components/AdminSidebar';

export default function SimulatorPage() {
  return (
    <div className="flex h-screen bg-hanok text-hanok-ink font-sans overflow-hidden">
      {/* Sidebar */}
      <AdminSidebar />

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-hanok-panel border-b border-hanok-line flex items-center justify-between px-8 flex-shrink-0">
          <div>
            <h2 className="text-xl font-bold text-hanok-ink">SPOT 시뮬레이터</h2>
            <p className="text-xs text-hanok-muted mt-0.5">취향·이동시간·혜택 가중치를 바꿔 추천 점수가 어떻게 달라지는지 미리 봅니다</p>
          </div>
        </header>

        {/* Simulator Content Area */}
        <div className="flex-1 min-h-0 p-8 overflow-y-auto pb-20">
          <div className="max-w-7xl mx-auto space-y-6">
            <SPOTSimulator />
          </div>
        </div>
      </main>
    </div>
  );
}