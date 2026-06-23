// Çeviri sesini (24 kHz PCM16 -> Float32) kesintisiz çalan worklet.
// Ana iş parçacığından gelen Float32Array parçalarını bir kuyrukta tutar,
// her ses bloğunda sırayla çıkışa yazar. 'clear' mesajı kuyruğu boşaltır.
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._cur = null;
    this._pos = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this._queue = [];
        this._cur = null;
        this._pos = 0;
      } else {
        this._queue.push(e.data);
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    for (let i = 0; i < out.length; i++) {
      if (!this._cur || this._pos >= this._cur.length) {
        this._cur = this._queue.shift() || null;
        this._pos = 0;
      }
      out[i] = this._cur ? this._cur[this._pos++] : 0;
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
