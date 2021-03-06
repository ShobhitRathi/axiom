import * as http from "http";
import * as WebSocket from "ws";
const url = require("url");

import KeyPair from "../iso/KeyPair";
import Node from "../iso/Node";
import Peer from "../iso/Peer";
import Sequence from "../iso/Sequence";

// A PeerServer listens for websockets and exchanges enough information over them
// to construct a Peer connection.
export default class PeerServer {
  verbose: boolean;
  peerHandler: (Peer) => void;
  keyPair: KeyPair;
  port: number;
  node: Node;

  constructor(keyPair: KeyPair, port: number, verbose: boolean) {
    this.keyPair = keyPair;
    if (!this.keyPair) {
      this.keyPair = KeyPair.fromRandom();
    }
    this.port = port;
    this.verbose = verbose;
    this.peerHandler = null;
    this.node = null;

    let server = http.createServer((req, res) => {
      let parsed = url.parse(req.url, true);
      if (parsed.pathname === "/healthz") {
        res.write("OK\n");
        res.end();
        return;
      }

      if (parsed.pathname === "/statusz") {
        let status = this.status();
        for (let line of status) {
          res.write(line + "\n");
        }
        res.end();
        return;
      }
    });

    let wss = new WebSocket.Server({ server: server });
    wss.on("connection", ws => {
      let peer = new Peer({ keyPair: this.keyPair, verbose: verbose });

      peer.signals.forEach(data => {
        ws.send(JSON.stringify(data));
      });

      let incomingSignals = new Sequence<object>();
      ws.on("message", encoded => {
        try {
          let signal = JSON.parse(encoded);
          incomingSignals.push(signal);
        } catch (e) {
          console.log("websocket decoding error:", e);
        }
      });
      peer.connect(incomingSignals);

      if (this.peerHandler) {
        this.peerHandler(peer);
      }
    });

    server.listen(port);
  }

  log(...args) {
    if (this.verbose) {
      console.log(...args);
    }
  }

  status(): string[] {
    if (this.node) {
      return this.node.statusLines();
    }

    return ["this.node == null"];
  }

  onPeer(callback: (Peer) => void) {
    if (this.peerHandler) {
      throw new Error("onPeer can only be called once");
    }
    this.peerHandler = callback;
  }

  // Let peers connect to the provided node through this PeerServer.
  connectNode(node: Node) {
    if (this.node) {
      throw new Error("can only connectNode once");
    }
    this.node = node;
    if (this.keyPair.getPublicKey() !== this.node.keyPair.getPublicKey()) {
      throw new Error("keys from PeerServer and Node must match");
    }
    this.onPeer(async peer => {
      await peer.waitUntilConnected();
      this.node.addPeer(peer);
    });
  }
}
