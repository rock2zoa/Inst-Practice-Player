let apiPromise = null;

function loadApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve();
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (previous) previous();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      apiPromise = null;
      reject(new Error("유튜브 플레이어를 불러오지 못했습니다. 인터넷 연결을 확인해주세요."));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export function parseVideoId(input) {
  const text = (input || "").trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch (e) {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

export class YoutubeController {
  constructor(container) {
    this.container = container;
    this.player = null;
    this.onError = null;
    this.onStateChange = null;
  }

  async open(videoId) {
    this.destroy();
    await loadApi();
    const host = document.createElement("div");
    this.container.appendChild(host);
    await new Promise((resolve, reject) => {
      this.player = new window.YT.Player(host, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => resolve(),
          onStateChange: (e) => {
            if (this.onStateChange) this.onStateChange(e.data);
          },
          onError: (e) => {
            if (this.onError) this.onError(e.data);
            reject(new Error(`youtube error ${e.data}`));
          },
        },
      });
    }).catch(() => {});
  }

  get ready() {
    return !!(this.player && this.player.getCurrentTime);
  }

  getTime() {
    return this.ready ? this.player.getCurrentTime() : 0;
  }

  getDuration() {
    return this.ready ? this.player.getDuration() || 0 : 0;
  }

  isPlaying() {
    if (!this.ready) return false;
    const s = this.player.getPlayerState();
    return s === 1 || s === 3;
  }

  getTitle() {
    try {
      return (this.ready && this.player.getVideoData().title) || "";
    } catch (e) {
      return "";
    }
  }

  getRates() {
    try {
      const rates = this.ready ? this.player.getAvailablePlaybackRates() : null;
      if (rates && rates.length) return rates.slice().sort((a, b) => a - b);
    } catch (e) {
      /* fall through */
    }
    return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  }

  play() {
    if (this.ready) this.player.playVideo();
  }

  pause() {
    if (this.ready) this.player.pauseVideo();
  }

  seek(seconds) {
    if (this.ready) this.player.seekTo(seconds, true);
  }

  setRate(rate) {
    if (this.ready) this.player.setPlaybackRate(rate);
  }

  destroy() {
    if (this.player) {
      try {
        this.player.destroy();
      } catch (e) {
        /* already gone */
      }
      this.player = null;
    }
    this.container.replaceChildren();
  }
}
