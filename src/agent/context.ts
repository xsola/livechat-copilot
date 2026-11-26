export interface AgentContext {
  room: {
    title: string | null;
    streamer: string | null;
    category: string | null;
    replyLanguage: string | null;
  };
  messages: Array<{ observedAt: number; text: string }>;
}

export function draftContext(source: AgentContext) {
  return {
    title: source.room.title,
    streamer: source.room.streamer,
    category: source.room.category,
    recentChat: source.messages.slice(-35).map(({ text }) => text.slice(0, 200)),
  };
}
