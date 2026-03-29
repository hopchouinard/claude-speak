export function extractMessage(input: string): string | null {
  try {
    const data = JSON.parse(input);

    // Claude Code Stop/Notification hook format: { last_assistant_message: "..." }
    if (typeof data?.last_assistant_message === 'string' && data.last_assistant_message.length > 0) {
      return data.last_assistant_message;
    }

    // Fallback: message.content format
    if (data?.message?.content && typeof data.message.content === 'string') {
      return data.message.content || null;
    }

    // Fallback: bare message string
    if (typeof data?.message === 'string' && data.message.length > 0) {
      return data.message;
    }

    return null;
  } catch {
    return null;
  }
}
