// Mikrofon yakalama worklet'i.
// AudioContext 16 kHz olarak açıldığı için tarayıcı sesi zaten 16 kHz'e indirir.
// Burada gelen Float32 örnekleri 100 ms'lik bloklar halinde PCM16 (little-endian)
// olarak ana iş parçacığına gönderiyoruz.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._target = 1600; // 16000 * 0.1 = 100 ms
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);

      while (this._buf.length >= this._target) {
        const frame = this._buf.splice(0, this._target);
        const pcm = new Int16Array(frame.length);
        for (let i = 0; i < frame.length; i++) {
          let s = frame[i];
          if (s > 1) s = 1;
          else if (s < -1) s = -1;
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        // Transferable: kopyasız gönderim
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
