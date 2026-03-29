export function extractMessage(input) {
    try {
        const data = JSON.parse(input);
        if (data?.message?.content && typeof data.message.content === 'string') {
            return data.message.content || null;
        }
        if (typeof data?.message === 'string' && data.message.length > 0) {
            return data.message;
        }
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=extractor.js.map