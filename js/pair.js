// Pairing a phone with this page, browser to browser, with no server in between.
//
// WebRTC needs the two ends to swap one message each (an "offer" and an
// "answer") before they can talk. There is no server to carry them, so they
// are plain text codes that a person copies across - over a chat app, say:
//
//   PC page  : Host.offer()        -> code A   (shown, copied to the phone)
//   phone    : Guest.join(code A)  -> code B   (shown, copied back to the PC)
//   PC page  : Host.accept(code B) -> connected; the phone sends its turn
//                                     over a data channel from then on.
//
// A public STUN server (Google's) lets the two find each other through home
// routers. There is no TURN relay, so two networks that both block direct
// connections (some mobile carriers) cannot pair; same Wi-Fi nearly always can.
// Messages on the channel are small JSON objects: { t: 'turn', v: degrees },
// { t: 'zero' }, { t: 'hello' }.
(function () {
  'use strict';
  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const GATHER_MS = 5000;   // give up waiting for more network candidates after this long

  const b64url = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64url = (text) => {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  // { type, sdp } -> a short text. 'z' = deflated, 'p' = plain (a browser without CompressionStream).
  async function pack(desc) {
    let bytes = new TextEncoder().encode(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
    if (typeof CompressionStream !== 'undefined') return 'z' + b64url(await pipe(bytes, new CompressionStream('deflate-raw')));
    return 'p' + b64url(bytes);
  }
  async function unpack(text) {
    const t = String(text || '').replace(/\s+/g, '');
    if (t.length < 20) throw new Error('that code is too short - copy the whole thing');
    let bytes = unb64url(t.slice(1));
    if (t[0] === 'z') {
      if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot read that code (no DecompressionStream)');
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } else if (t[0] !== 'p') throw new Error('that is not a pairing code');
    const o = JSON.parse(new TextDecoder().decode(bytes));
    if (!o || typeof o.sdp !== 'string') throw new Error('that is not a pairing code');
    return o;
  }

  function gathered(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(timer); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, GATHER_MS);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // Both ends: onState(text, connected), onMessage(obj).
  class Link {
    constructor() { this.pc = null; this.ch = null; this.onState = null; this.onMessage = null; this.connected = false; }
    _bind(pc) {
      this.pc = pc;
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        this.connected = st === 'connected' && !!this.ch && this.ch.readyState === 'open';
        if (this.onState) this.onState(st, this.connected);
      };
    }
    _channel(ch) {
      this.ch = ch;
      ch.onopen = () => { this.connected = true; if (this.onState) this.onState('connected', true); };
      ch.onclose = () => { this.connected = false; if (this.onState) this.onState('closed', false); };
      ch.onmessage = (ev) => { let o; try { o = JSON.parse(ev.data); } catch (e) { return; } if (this.onMessage) this.onMessage(o); };
    }
    send(obj) { if (this.ch && this.ch.readyState === 'open') this.ch.send(JSON.stringify(obj)); }
    close() { try { if (this.ch) this.ch.close(); if (this.pc) this.pc.close(); } catch (e) {} this.connected = false; }
  }

  class Host extends Link {
    async offer() {
      this.close();
      this._bind(new RTCPeerConnection(RTC_CONFIG));
      this._channel(this.pc.createDataChannel('ctl', { ordered: true }));
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await gathered(this.pc);
      return pack(this.pc.localDescription);
    }
    async accept(code) {
      if (!this.pc) throw new Error('make a code first');
      await this.pc.setRemoteDescription(await unpack(code));
    }
  }

  class Guest extends Link {
    async join(code) {
      this.close();
      const offer = await unpack(code);
      this._bind(new RTCPeerConnection(RTC_CONFIG));
      this.pc.ondatachannel = (ev) => this._channel(ev.channel);
      await this.pc.setRemoteDescription(offer);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await gathered(this.pc);
      return pack(this.pc.localDescription);
    }
  }

  window.SSPair = { Host, Guest, pack, unpack };
})();
