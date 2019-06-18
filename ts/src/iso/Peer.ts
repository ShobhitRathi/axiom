import * as SimplePeer from "simple-peer";
import WebSocket = require("isomorphic-ws");

import KeyPair from "./KeyPair";
import Message from "./Message";
import Sequence from "./Sequence";
import SignedMessage from "./SignedMessage";

// Optional dependencies.
// TODO: solve this at compile-time rather than at runtime
let OPTIONAL = {
  wrtc: null
};
declare var global: any;
declare var require: any;
if (typeof global === "object") {
  // Looks like a node environment.
  // TODO: could it be the jest pretending-to-be-a-browser-but-really-node environment?
  // That will be required to make any jest-browser tests use this file.
  OPTIONAL.wrtc = require("wrtc");
}

// A Peer represents a connection to a single other node in the Axiom peer-to-peer
// network.
export default class Peer {
  verbose: boolean;
  keyPair: KeyPair;

  // The public key we expect to be connecting to.
  // This is null if we don't care who we are connecting to.
  peerPublicKey: string;

  // The signals emitted by this peer
  signals: Sequence<object>;

  _peer: SimplePeer;

  // Creates a Peer by connecting to a PeerServer
  static connectToServer(url: string, verbose: boolean): Peer {
    let peer = new Peer({ initiator: true, verbose: verbose });
    let ws = new WebSocket(url);

    ws.onopen = () => {
      peer.signals.forEach(signal => {
        ws.send(JSON.stringify(signal));
      });
    };

    let incomingSignals = new Sequence<object>();
    ws.onmessage = event => {
      try {
        let signal = JSON.parse(event.data);
        incomingSignals.push(signal);
      } catch (e) {
        console.log("websocket decoding error:", e);
      }
    };
    peer.connect(incomingSignals);

    peer.onConnect(() => {
      ws.close();
    });

    return peer;
  }

  constructor(options: {
    keyPair?: KeyPair;
    peerPublicKey?: string;
    initiator?: boolean;
    verbose?: boolean;
  }) {
    this.verbose = !!options.verbose;

    this.keyPair = options.keyPair;
    if (!this.keyPair) {
      this.keyPair = KeyPair.fromRandom();
    }
    this.peerPublicKey = options.peerPublicKey;
    this._peer = new SimplePeer({
      initiator: !!options.initiator,
      wrtc: OPTIONAL.wrtc
    });

    this.signals = new Sequence<object>();
    this._peer.on("signal", obj => {
      this.signals.push(obj);
    });
  }

  connect(signals: Sequence<object>) {
    signals.forEach(obj => {
      this._peer.signal(obj);
    });
  }

  log(...args) {
    if (this.verbose) {
      console.log(...args);
    }
  }

  onConnect(callback: () => void) {
    this._peer.on("connect", callback);
  }

  onData(callback: (data: any) => void) {
    this._peer.on("data", callback);
  }

  onError(callback: (Error) => void) {
    this._peer.on("error", callback);
  }

  sendData(data: any) {
    this._peer.send(data);
  }

  sendMessage(message: Message) {
    let signed = SignedMessage.fromSigning(message, this.keyPair);
    this.sendData(signed.serialize());
  }

  onMessage(callback: (message: Message) => void) {
    this.onData(data => {
      // TODO: don't convert to string needlessly
      let s = data.toString();
      let sm;
      try {
        sm = SignedMessage.fromSerialized(s);
      } catch (e) {
        this.log("error in decoding signed message:", e);
        return;
      }
      if (this.peerPublicKey && this.peerPublicKey != sm.signer) {
        this.log(
          "expected message from",
          this.peerPublicKey,
          "but received message from",
          sm.signer
        );
        return;
      }
      callback(sm.message);
    });
  }

  destroy() {
    this._peer.destroy();
    this.signals.finish();
  }

  async waitUntilConnected() {
    if (this._peer.connected) {
      return;
    }
    return new Promise((resolve, reject) => {
      this.onConnect(resolve);
    });
  }
}