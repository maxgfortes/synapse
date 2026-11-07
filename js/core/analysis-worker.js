// Roda a analise de audio fora da thread principal.

import { analyzePCM } from '../metis/dsp.js';

self.onmessage = ({ data }) => {
  const { id, pcm, sampleRate } = data;
  try {
    self.postMessage({ id, result: analyzePCM(pcm, sampleRate) });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
