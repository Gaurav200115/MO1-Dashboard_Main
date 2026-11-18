// A stand-in for the kiteconnect package, for scripts/test-feed.mjs.
//
// Mimics the two things about the real KiteTicker that broke the desk:
//   - listeners live in ONE module-wide list, so every ticker ever made hears
//     every event ("close" goes to all of them, like the real trigger())
//   - disconnect() clears a module-wide "may reconnect" flag that nothing sets
//     back; with auto-reconnect on, the next drop then calls process.exit(1).
//     Here that is counted in `exits` instead of killing the test.
const state = {
  tickers: [],
  listeners: {},
  autoReconnect: false,
  autoReconnectCalls: [],
  shouldReconnect: true,
  exits: 0,
  instrumentCalls: 0,
};

class KiteTicker {
  constructor(params) {
    this.params = params;
    this.connectCalls = 0;
    this.disconnected = false;
    state.tickers.push(this);
  }
  autoReconnect(t) {
    state.autoReconnect = t;
    state.autoReconnectCalls.push(t);
  }
  on(event, callback) {
    (state.listeners[event] ??= []).push(callback);
  }
  connect() {
    this.connectCalls += 1;
  }
  disconnect() {
    state.shouldReconnect = false;
    this.disconnected = true;
  }
  subscribe() {}
  setMode() {}
}

function emit(event, ...args) {
  for (const callback of state.listeners[event] ?? []) callback(...args);
  if ((event === "close" || event === "disconnect") && state.autoReconnect && !state.shouldReconnect) {
    state.exits += 1; // the real library calls process.exit(1) here
  }
}

class KiteConnect {
  setAccessToken() {}
  async getInstruments() {
    state.instrumentCalls += 1;
    return [{ instrument_type: "EQ", instrument_token: 738561, tradingsymbol: "RELIANCE" }];
  }
}

module.exports = { KiteTicker, KiteConnect, __fake: { state, emit } };
