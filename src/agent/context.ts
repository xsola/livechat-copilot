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

export function analysisContext(source: AgentContext, now = Date.now()) {
  const messages = source.messages.filter(({ observedAt }) => observedAt >= now - 120_000 && observedAt <= now)
    .slice(-60);
  return {
    title: source.room.title,
    streamer: source.room.streamer,
    category: source.room.category,
    messages: messages.map(({ observedAt, text }, index) => ({
      id: index + 1, secondsAgo: Math.round((now - observedAt) / 1000), text: text.slice(0, 200),
    })),
    from: messages[0]?.observedAt ?? now,
    to: messages.at(-1)?.observedAt ?? now,
  };
}
