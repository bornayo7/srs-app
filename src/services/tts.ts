import { containsKana } from '@/engine/grading/normalize';

/**
 * Text-to-speech via the browser's built-in speechSynthesis — free, offline,
 * no key. Voice picked by script detection; always user-initiated (a button),
 * never autoplay.
 */

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

export function speak(text: string): void {
  if (!ttsSupported()) return;
  const cleaned = text.replace(/＿+|_{2,}/g, '…').trim();
  if (!cleaned) return;
  window.speechSynthesis.cancel(); // one utterance at a time
  const utterance = new SpeechSynthesisUtterance(cleaned);
  const lang = containsKana(cleaned) ? 'ja-JP' : 'en-US';
  utterance.lang = lang;
  const voice = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang.replace('_', '-').startsWith(lang.slice(0, 2)));
  if (voice) utterance.voice = voice;
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}
