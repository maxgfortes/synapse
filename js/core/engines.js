import { bus } from './bus.js';

export class AudioEngine {
  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.setAttribute('playsinline', '');
    this.url = null;
    this.el.addEventListener('timeupdate', () => bus.emit('engine:time'));
    this.el.addEventListener('durationchange', () => bus.emit('engine:duration', this.el.duration));
    this.el.addEventListener('play', () => bus.emit('engine:state', true));
    this.el.addEventListener('pause', () => bus.emit('engine:state', false));
    this.el.addEventListener('ended', () => bus.emit('engine:ended'));
    this.el.addEventListener('error', () => {
      if (this.el.src) bus.emit('engine:error', 'audio');
    });
  }

  async load(blob, startAt = 0) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.el.src = this.url;
    if (startAt) this.el.currentTime = startAt;
    await this.el.play();
  }

  play() { return this.el.play(); }
  pause() { this.el.pause(); }
  stop() { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); }
  seek(seconds) { this.el.currentTime = seconds; }
  setVolume(value) { this.el.volume = value; }
  get currentTime() { return this.el.currentTime || 0; }
  get duration() { return this.el.duration || 0; }
  get playing() { return !this.el.paused; }
}

let apiPromise = null;

function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('youtube-api-blocked'));
    };
    document.head.append(script);
  });
  return apiPromise;
}

export class YouTubeEngine {
  constructor() {
    this.player = null;
    this.ready = null;
    this.timer = null;
    this.isPlaying = false;
    this.volume = 0.8;
  }

  async _ensure() {
    if (this.ready) return this.ready;
    this.ready = loadYouTubeApi().then((YT) => new Promise((resolve) => {
      this.player = new YT.Player('yt-frame', {
        width: 200,
        height: 200,
        playerVars: { playsinline: 1, controls: 0, disablekb: 1, fs: 0, rel: 0 },
        events: {
          onReady: () => {
            this.player.setVolume(Math.round(this.volume * 100));
            resolve(this.player);
          },
          onStateChange: (event) => this._onState(event.data),
          onError: (event) => bus.emit('engine:error', `youtube:${event.data}`),
        },
      });
    }));
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  _onState(state) {
    const S = window.YT.PlayerState;
    if (state === S.PLAYING) {
      this.isPlaying = true;
      bus.emit('engine:state', true);
      bus.emit('engine:duration', this.duration);
      this._tick();
    } else if (state === S.PAUSED) {
      this.isPlaying = false;
      bus.emit('engine:state', false);
      this._stopTick();
    } else if (state === S.ENDED) {
      this.isPlaying = false;
      this._stopTick();
      bus.emit('engine:ended');
    }
  }

  _tick() {
    this._stopTick();
    this.timer = setInterval(() => bus.emit('engine:time'), 500);
  }

  _stopTick() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async load(videoId, startAt = 0) {
    const player = await this._ensure();
    player.loadVideoById({ videoId, startSeconds: startAt });
  }

  play() { this.player?.playVideo(); }
  pause() { this.player?.pauseVideo(); }
  stop() {
    this._stopTick();
    this.isPlaying = false;
    this.player?.stopVideo?.();
  }
  seek(seconds) { this.player?.seekTo(seconds, true); }
  setVolume(value) {
    this.volume = value;
    this.player?.setVolume?.(Math.round(value * 100));
  }
  get currentTime() { return this.player?.getCurrentTime?.() || 0; }
  get duration() { return this.player?.getDuration?.() || 0; }
  get playing() { return this.isPlaying; }
}
