'use client';

import ChatPanel from '@/components/chat/ChatPanel';
import { useMarkThreadSeen } from '@/lib/chat/use-mark-thread-seen';

type Props = {
  userId: string;
};

export function PeterChatClient({ userId }: Props) {
  useMarkThreadSeen('peter');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 88px)' }}>
      <ChatPanel userId={userId} embedded={true} initialKind="coach" thread="peter" />
    </div>
  );
}
