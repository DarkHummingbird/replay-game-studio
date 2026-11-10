import { describe, expect, it } from 'vitest';
import { shouldSubmitPrompt } from './promptSubmission';

describe('prompt submission keyboard behavior', () => {
  it('sends on Enter and keeps Shift+Enter for multiline input', () => {
    expect(shouldSubmitPrompt({ key: 'Enter', shiftKey: false, nativeEvent: {} })).toBe(true);
    expect(shouldSubmitPrompt({ key: 'Enter', shiftKey: true, nativeEvent: {} })).toBe(false);
    expect(shouldSubmitPrompt({ key: 'a', shiftKey: false, nativeEvent: {} })).toBe(false);
  });
  it('does not send while confirming Chinese input, including legacy IME events', () => {
    expect(shouldSubmitPrompt({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } })).toBe(false);
    expect(shouldSubmitPrompt({ key: 'Enter', shiftKey: false, nativeEvent: { keyCode: 229 } })).toBe(false);
  });
});
