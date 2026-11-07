// Rede Wide & Deep minima com backprop escrito a mao e otimizador Adam.
// Sem TensorFlow: treina no aparelho e os pesos cabem em um JSON exportavel.

import { makeRng, sigmoid, clamp } from './math.js';

const zeros = (n) => new Float64Array(n);

export class WideDeep {
  constructor({ inputDim, wideDim, hidden = [32, 16], lr = 0.012, l2 = 2e-4, seed = 7 }) {
    this.inputDim = inputDim;
    this.wideDim = wideDim;
    this.hidden = hidden;
    this.lr = lr;
    this.l2 = l2;
    this.steps = 0;
    const rng = makeRng(seed);
    const init = (n, scale) => Float64Array.from({ length: n }, () => (rng() - 0.5) * 2 * scale);

    this.W = [];
    this.b = [];
    let inDim = inputDim;
    for (const out of hidden) {
      this.W.push(init(inDim * out, Math.sqrt(1 / inDim)));
      this.b.push(zeros(out));
      inDim = out;
    }
    this.wOut = init(inDim, 0.05);
    this.wWide = zeros(wideDim);
    this.bOut = [0];
    this._initAdam();
  }

  _params() {
    return [...this.W, ...this.b, this.wOut, this.wWide, this.bOut];
  }

  _initAdam() {
    const params = this._params();
    this.m = params.map((p) => zeros(p.length));
    this.s = params.map((p) => zeros(p.length));
  }

  _forward(x, wide) {
    const activations = [x];
    let h = x;
    for (let l = 0; l < this.hidden.length; l++) {
      const inDim = h.length;
      const out = this.hidden[l];
      const W = this.W[l];
      const b = this.b[l];
      const next = zeros(out);
      for (let i = 0; i < out; i++) {
        let s = b[i];
        const row = i * inDim;
        for (let j = 0; j < inDim; j++) s += W[row + j] * h[j];
        next[i] = Math.tanh(s);
      }
      activations.push(next);
      h = next;
    }
    let out = this.bOut[0];
    for (let i = 0; i < h.length; i++) out += this.wOut[i] * h[i];
    for (let i = 0; i < this.wideDim; i++) out += this.wWide[i] * wide[i];
    return { out, activations };
  }

  logit(x, wide) {
    return this._forward(x, wide).out;
  }

  predict(x, wide) {
    return sigmoid(this.logit(x, wide));
  }

  // batch: [{ x, wide, y, w }]. Devolve a perda media antes do passo.
  train(batch) {
    const params = this._params();
    const grads = params.map((p) => zeros(p.length));
    const nW = this.W.length;
    let loss = 0;
    let totalWeight = 0;

    for (const { x, wide, y, w = 1 } of batch) {
      const { out, activations } = this._forward(x, wide);
      const p = sigmoid(out);
      const eps = 1e-7;
      loss += -w * (y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
      totalWeight += w;
      const dOut = (p - y) * w;

      const last = activations[activations.length - 1];
      const gWOut = grads[2 * nW];
      for (let i = 0; i < last.length; i++) gWOut[i] += dOut * last[i];
      const gWide = grads[2 * nW + 1];
      for (let i = 0; i < this.wideDim; i++) gWide[i] += dOut * wide[i];
      grads[2 * nW + 2][0] += dOut;

      let dH = Float64Array.from(this.wOut, (v) => v * dOut);
      for (let l = this.hidden.length - 1; l >= 0; l--) {
        const prev = activations[l];
        const inDim = prev.length;
        const width = this.hidden[l];
        const gW = grads[l];
        const gB = grads[nW + l];
        const W = this.W[l];
        const dPrev = zeros(inDim);
        for (let i = 0; i < width; i++) {
          const t = activations[l + 1][i];
          const d = dH[i] * (1 - t * t);
          gB[i] += d;
          const row = i * inDim;
          for (let j = 0; j < inDim; j++) {
            gW[row + j] += d * prev[j];
            dPrev[j] += d * W[row + j];
          }
        }
        dH = dPrev;
      }
    }

    this._adamStep(params, grads, Math.max(totalWeight, 1e-6));
    return loss / Math.max(totalWeight, 1e-6);
  }

  _adamStep(params, grads, scale) {
    this.steps++;
    const b1 = 0.9;
    const b2 = 0.999;
    const correct1 = 1 - b1 ** this.steps;
    const correct2 = 1 - b2 ** this.steps;
    for (let k = 0; k < params.length; k++) {
      const p = params[k];
      const g = grads[k];
      const m = this.m[k];
      const s = this.s[k];
      for (let i = 0; i < p.length; i++) {
        const grad = clamp(g[i] / scale, -5, 5) + this.l2 * p[i];
        m[i] = b1 * m[i] + (1 - b1) * grad;
        s[i] = b2 * s[i] + (1 - b2) * grad * grad;
        p[i] -= (this.lr * (m[i] / correct1)) / (Math.sqrt(s[i] / correct2) + 1e-8);
      }
    }
  }

  toJSON() {
    const pack = (a) => Array.from(a, (v) => Math.round(v * 1e6) / 1e6);
    return {
      inputDim: this.inputDim,
      wideDim: this.wideDim,
      hidden: this.hidden,
      lr: this.lr,
      l2: this.l2,
      steps: this.steps,
      W: this.W.map(pack),
      b: this.b.map(pack),
      wOut: pack(this.wOut),
      wWide: pack(this.wWide),
      bOut: this.bOut[0],
    };
  }

  static fromJSON(json) {
    const net = new WideDeep(json);
    net.W = json.W.map((a) => Float64Array.from(a));
    net.b = json.b.map((a) => Float64Array.from(a));
    net.wOut = Float64Array.from(json.wOut);
    net.wWide = Float64Array.from(json.wWide);
    net.bOut = [json.bOut];
    net._initAdam();
    return net;
  }
}
