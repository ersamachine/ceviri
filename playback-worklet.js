// Çeviri sesini akıcı çalan worklet — ön-tamponlu (jitter buffer).
// Ses WebSocket'ten düzensiz aralıklarla geldiği için, doğrudan çalmak
// kesilmelere yol açar. Bu yüzden önce belirli bir miktar ses biriktirip
// (prebuffer) öyle çalmaya başlarız; kuyruk boşalırsa (underrun) tek tek
// boşluk basmak yerine yeniden tamponlarız. 'clear' kuyruğu boşaltır.
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = (options && options.processorOptions) || {};
    // sampleRate: worklet global'i = AudioContext gerçek hızı.
    this._prebuffer = Math.round(sampleRate * (opt.prebufferSec || 0.25));
    this._queue = [];
    this._queued = 0; // bekleyen toplam örnek (kuyruk + mevcut parça kalanı)
    this._cur = null;
    this._pos = 0;
    this._playing = false;

    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this._queue = [];
        this._queued = 0;
        this._cur = null;
        this._pos = 0;
        this._playing = false;
        return;
      }
      this._queue.push(e.data);
      this._queued += e.data.length;
      if (!this._playing && this._queued >= this._prebuffer) this._playing = true;
    };
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    if (!channels || !channels[0]) return true;
    const frames = channels[0].length;
    const nCh = channels.length;

    // Henüz yeterince ses birikmedi → sessizlik (tamponla).
    if (!this._playing) {
      for (let c = 0; c < nCh; c++) channels[c].fill(0);
      return true;
    }

    for (let i = 0; i < frames; i++) {
      if (!this._cur || this._pos >= this._cur.length) {
        this._cur = this._queue.shift() || null;
        this._pos = 0;
      }
      if (this._cur) {
        const v = this._cur[this._pos++];
        this._queued--;
        for (let c = 0; c < nCh; c++) channels[c][i] = v;
      } else {
        // Underrun: kuyruk boşaldı → yeniden tamponlamaya geç.
        this._playing = false;
        for (let j = i; j < frames; j++) {
          for (let c = 0; c < nCh; c++) channels[c][j] = 0;
        }
        return true;
      }
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
