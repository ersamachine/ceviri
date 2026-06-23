// Mikrofon yakalama + yeniden örnekleme worklet'i.
// iPhone Safari gibi tarayıcılar AudioContext'i istenen 16 kHz'de açmaz
// (donanım hızını, genelde 48 kHz, kullanır). Bu yüzden gelen sesi GERÇEK
// bağlam hızından (sampleRate) hedef 16 kHz'e doğrusal interpolasyonla
// indirip PCM16 (little-endian) olarak 100 ms'lik bloklar halinde gönderiyoruz.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = (options && options.processorOptions) || {};
    this.targetRate = opt.targetRate || 16000;
    // sampleRate: worklet global'i = AudioContext'in gerçek hızı.
    this.ratio = sampleRate / this.targetRate; // çıkış başına düşen giriş örneği
    this._acc = [];   // henüz tüketilmemiş giriş örnekleri (float)
    this._frac = 0;   // bir sonraki okuma için kalan kesirli konum
    this._out = [];   // 16 kHz çıkış örnekleri (float)
    this._chunk = Math.round(this.targetRate * 0.1); // 1600 = 100 ms
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) this._acc.push(ch[i]);

      // Yeniden örnekleme (doğrusal interpolasyon)
      let pos = this._frac;
      while (pos + 1 < this._acc.length) {
        const i0 = Math.floor(pos);
        const t = pos - i0;
        this._out.push(this._acc[i0] * (1 - t) + this._acc[i0 + 1] * t);
        pos += this.ratio;
      }
      const consumed = Math.floor(pos);
      if (consumed > 0) this._acc = this._acc.slice(consumed);
      this._frac = pos - consumed;

      // 100 ms'lik bloklar halinde PCM16 gönder
      while (this._out.length >= this._chunk) {
        const frame = this._out.splice(0, this._chunk);
        const pcm = new Int16Array(frame.length);
        for (let i = 0; i < frame.length; i++) {
          let v = frame[i];
          if (v > 1) v = 1;
          else if (v < -1) v = -1;
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
